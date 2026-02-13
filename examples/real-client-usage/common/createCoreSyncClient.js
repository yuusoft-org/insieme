export function createCoreSyncClient({
  transport,
  store,
  token,
  clientId,
  partitions,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  onEvent = () => {},
}) {
  let connected = false;
  let syncInFlight = false;
  let stopped = false;
  let activePartitions = [...partitions];
  let unsubscribeTransport = null;

  const emit = (type, payload) => onEvent({ type, payload });

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
    }
  };

  const syncFromCursor = async () => {
    if (stopped) return;

    syncInFlight = true;
    const since = await store.loadCursor();

    await send("sync", {
      partitions: activePartitions,
      since_committed_id: since,
      limit: 500,
    });
  };

  const onConnected = async (payload) => {
    connected = true;
    emit("connected", payload);
    await syncFromCursor();
  };

  const onSubmitResult = async (payload) => {
    for (const result of payload.results || []) {
      if (result.status === "committed") {
        const draft = await store.getDraftById(result.id);
        if (draft) {
          await store.applyCommitted({
            committed_id: result.committed_id,
            id: result.id,
            client_id: clientId,
            partitions: draft.partitions,
            event: draft.event,
            status_updated_at: result.status_updated_at,
          });
        }
        await store.removeDraftById(result.id);
        emit("committed", result);
      } else {
        await store.removeDraftById(result.id);
        emit("rejected", result);
      }
    }
  };

  const onSyncResponse = async (payload) => {
    for (const event of payload.events || []) {
      await store.applyCommitted(event);
      await store.removeDraftById(event.id);
    }

    await store.saveCursor(payload.next_since_committed_id);
    emit("sync_page", payload);

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
    await flushDraftQueue();
  };

  const onBroadcast = async (payload) => {
    await store.applyCommitted(payload);
    await store.removeDraftById(payload.id);
    emit("broadcast", payload);
  };

  const onError = async (payload) => {
    emit("error", payload);

    if (payload.code === "auth_failed" || payload.code === "protocol_version_unsupported") {
      connected = false;
      await transport.disconnect();
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
    },

    setPartitions: async (nextPartitions) => {
      activePartitions = [...nextPartitions];
      await syncFromCursor();
    },

    submitEvent: async ({ partitions: eventPartitions, event }) => {
      const id = uuid();
      await store.insertDraft({
        id,
        client_id: clientId,
        partitions: eventPartitions,
        event,
        created_at: now(),
      });

      if (connected && !syncInFlight) {
        await send("submit_events", {
          events: [{ id, partitions: eventPartitions, event }],
        });
      }

      return id;
    },

    syncNow: async () => {
      await syncFromCursor();
    },

    flushDrafts: async () => {
      await flushDraftQueue();
    },
  };
}
