/**
 * @typedef {{
 *   id: string,
 *   clientId: string,
 *   partitions: string[],
 *   event: { type: string, payload: object },
 *   createdAt: number,
 * }} SubmitItem
 */

/**
 * @param {{
 *   transport: {
 *     send: (message: object) => Promise<void>,
 *     connect: () => Promise<void>,
 *     disconnect: () => Promise<void>,
 *     onMessage: (handler: (message: object) => void) => () => void,
 *   },
 *   store: {
 *     init: () => Promise<void>,
 *     loadCursor: () => Promise<number>,
 *     insertDraft: (item: SubmitItem) => Promise<void>,
 *     loadDraftsOrdered: () => Promise<SubmitItem[]>,
 *     applySubmitResult: (input: { result: object, fallbackClientId: string }) => Promise<void>,
 *     applyCommittedBatch: (input: { events: object[], nextCursor?: number }) => Promise<void>,
 *   },
 *   token: string,
 *   clientId: string,
 *   partitions: string[],
 *   now?: () => number,
 *   uuid?: () => string,
 *   validateLocalEvent?: (item: SubmitItem) => void,
 *   onEvent?: (input: { type: string, payload: any }) => void,
 *   logger?: (entry: object) => void,
 * }} deps
 */
export const createSyncClient = ({
  transport,
  store,
  token,
  clientId,
  partitions,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  validateLocalEvent = () => {},
  onEvent = () => {},
  logger = () => {},
}) => {
  let connected = false;
  let syncInFlight = false;
  let stopped = false;
  let activePartitions = [...partitions];
  /** @type {null|(() => void)} */
  let unsubscribeTransport = null;

  const emit = (type, payload) => onEvent({ type, payload });
  const log = (entry) => logger({ component: "sync_client", ...entry });

  const send = (type, payload) =>
    transport.send({
      type,
      protocol_version: "1.0",
      timestamp: now(),
      payload,
    });

  const flushDraftQueue = async () => {
    if (!connected || syncInFlight || stopped) return;

    const drafts = await store.loadDraftsOrdered();
    log({
      event: "flush_drafts",
      draft_count: drafts.length,
    });
    for (const draft of drafts) {
      await send("submit_events", {
        events: [
          {
            id: draft.id,
            partitions: draft.partitions,
            event: draft.event,
          },
        ],
      });
      log({
        event: "submit_sent",
        id: draft.id,
      });
    }
  };

  const syncFromCursor = async (sinceOverride) => {
    if (stopped) return;

    syncInFlight = true;
    const since =
      typeof sinceOverride === "number"
        ? sinceOverride
        : await store.loadCursor();
    log({
      event: "sync_requested",
      partitions: activePartitions,
      since_committed_id: since,
    });

    await send("sync", {
      partitions: activePartitions,
      since_committed_id: since,
      limit: 500,
    });
  };

  const onConnected = async (payload) => {
    connected = true;
    log({
      event: "connected",
      client_id: payload?.client_id,
      server_last_committed_id: payload?.server_last_committed_id,
    });
    emit("connected", payload);
    await syncFromCursor();
  };

  const onSubmitResult = async (payload) => {
    for (const result of payload.results || []) {
      await store.applySubmitResult({ result, fallbackClientId: clientId });

      if (result.status === "committed") {
        log({
          event: "submit_committed",
          id: result.id,
          committed_id: result.committed_id,
        });
        emit("committed", result);
      } else {
        log({
          event: "submit_rejected",
          id: result.id,
          reason: result.reason,
        });
        emit("rejected", result);
      }
    }
  };

  const onSyncResponse = async (payload) => {
    await store.applyCommittedBatch({
      events: payload.events || [],
      nextCursor: payload.next_since_committed_id,
    });

    emit("sync_page", payload);
    log({
      event: "sync_page_applied",
      event_count: (payload.events || []).length,
      next_since_committed_id: payload.next_since_committed_id,
      has_more: payload.has_more,
    });

    if (payload.has_more) {
      await send("sync", {
        partitions: activePartitions,
        since_committed_id: payload.next_since_committed_id,
        limit: 500,
      });
      return;
    }

    syncInFlight = false;
    emit("synced", { cursor: payload.next_since_committed_id });
    log({
      event: "synced",
      cursor: payload.next_since_committed_id,
    });
    await flushDraftQueue();
  };

  const onBroadcast = async (payload) => {
    await store.applyCommittedBatch({ events: [payload] });
    log({
      event: "broadcast_applied",
      id: payload.id,
      committed_id: payload.committed_id,
    });
    emit("broadcast", payload);
  };

  const onError = async (payload) => {
    emit("error", payload);
    log({
      event: "error_received",
      code: payload.code,
    });

    if (
      payload.code === "auth_failed" ||
      payload.code === "protocol_version_unsupported" ||
      payload.code === "server_error"
    ) {
      connected = false;
      await transport.disconnect();
      log({
        event: "transport_disconnected",
        code: payload.code,
      });
    }
  };

  const handleServerMessage = async (message) => {
    switch (message.type) {
      case "connected":
        await onConnected(message.payload);
        return;
      case "submit_events_result":
        await onSubmitResult(message.payload);
        return;
      case "sync_response":
        await onSyncResponse(message.payload);
        return;
      case "event_broadcast":
        await onBroadcast(message.payload);
        return;
      case "error":
        await onError(message.payload);
        return;
      default:
        emit("unknown_message", message);
    }
  };

  return {
    start: async () => {
      await store.init();
      await transport.connect();
      log({ event: "transport_connected" });
      unsubscribeTransport = transport.onMessage((message) => {
        void handleServerMessage(message);
      });

      await send("connect", {
        token,
        client_id: clientId,
      });
    },

    stop: async () => {
      stopped = true;
      if (unsubscribeTransport) unsubscribeTransport();
      await transport.disconnect();
      log({ event: "stopped" });
    },

    setPartitions: async (nextPartitions, options = {}) => {
      activePartitions = [...nextPartitions];
      await syncFromCursor(options.sinceCommittedId);
    },

    submitEvent: async ({ partitions: eventPartitions, event }) => {
      const id = uuid();
      const draft = {
        id,
        clientId,
        partitions: eventPartitions,
        event,
        createdAt: now(),
      };

      validateLocalEvent(draft);
      await store.insertDraft(draft);
      log({
        event: "draft_inserted",
        id,
      });

      if (connected && !syncInFlight) {
        await send("submit_events", {
          events: [{ id, partitions: eventPartitions, event }],
        });
        log({
          event: "submit_sent",
          id,
        });
      }

      return id;
    },

    syncNow: async (options = {}) => {
      await syncFromCursor(options.sinceCommittedId);
    },

    flushDrafts: async () => {
      await flushDraftQueue();
    },
  };
};
