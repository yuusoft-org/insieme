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
 *   msgId?: () => string,
 *   validateLocalEvent?: (item: SubmitItem) => void,
 *   onEvent?: (input: { type: string, payload: any }) => void,
 *   logger?: (entry: object) => void,
 *   reconnect?: {
 *     enabled?: boolean,
 *     initialDelayMs?: number,
 *     maxDelayMs?: number,
 *     factor?: number,
 *     jitter?: number,
 *     maxAttempts?: number,
 *     handshakeTimeoutMs?: number,
 *   },
 *   sleep?: (ms: number) => Promise<void>,
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
  msgId = () => crypto.randomUUID(),
  validateLocalEvent = () => {},
  onEvent = () => {},
  logger = () => {},
  reconnect = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  const isObject = (value) => !!value && typeof value === "object";

  const reconnectPolicy = {
    enabled: reconnect.enabled === true,
    initialDelayMs:
      Number.isFinite(reconnect.initialDelayMs) && reconnect.initialDelayMs >= 0
        ? reconnect.initialDelayMs
        : 250,
    maxDelayMs:
      Number.isFinite(reconnect.maxDelayMs) && reconnect.maxDelayMs >= 0
        ? reconnect.maxDelayMs
        : 5000,
    factor:
      Number.isFinite(reconnect.factor) && reconnect.factor >= 1
        ? reconnect.factor
        : 2,
    jitter:
      Number.isFinite(reconnect.jitter) &&
      reconnect.jitter >= 0 &&
      reconnect.jitter <= 1
        ? reconnect.jitter
        : 0.2,
    maxAttempts:
      reconnect.maxAttempts === undefined ||
      reconnect.maxAttempts === null ||
      reconnect.maxAttempts === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(reconnect.maxAttempts) && reconnect.maxAttempts >= 0
          ? reconnect.maxAttempts
          : Number.POSITIVE_INFINITY,
    handshakeTimeoutMs:
      Number.isFinite(reconnect.handshakeTimeoutMs) &&
      reconnect.handshakeTimeoutMs > 0
        ? reconnect.handshakeTimeoutMs
        : 5000,
  };

  let started = false;
  let connected = false;
  let syncInFlight = false;
  let stopped = false;
  let activePartitions = [...partitions];
  let reconnectInFlight = false;
  let reconnectAttempts = 0;
  /** @type {null|(() => void)} */
  let unsubscribeTransport = null;
  /** @type {Promise<void>} */
  let inboundQueue = Promise.resolve();
  /** @type {Map<number, { resolve: () => void, reject: (reason?: unknown) => void }>} */
  const connectWaiters = new Map();
  let connectWaiterId = 0;

  const emit = (type, payload) => onEvent({ type, payload });
  const log = (entry) => {
    try {
      logger({ component: "sync_client", ...entry });
    } catch {
      // logging must not affect client runtime behavior
    }
  };

  const send = async (type, payload, options = {}) => {
    const outboundMsgId =
      typeof options.msgId === "string" ? options.msgId : msgId();
    await transport.send({
      type,
      protocol_version: "1.0",
      timestamp: now(),
      msg_id: outboundMsgId,
      payload,
    });
    return outboundMsgId;
  };

  const waitForConnected = (timeoutMs) => {
    if (connected) return Promise.resolve();

    const waiterId = connectWaiterId + 1;
    connectWaiterId = waiterId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connectWaiters.delete(waiterId);
        reject(new Error("connected timeout"));
      }, timeoutMs);
      connectWaiters.set(waiterId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
    });
  };

  const settleConnectWaiters = (ok, reason) => {
    for (const [waiterId, waiter] of connectWaiters) {
      connectWaiters.delete(waiterId);
      if (ok) {
        waiter.resolve();
      } else {
        waiter.reject(reason);
      }
    }
  };

  const computeReconnectDelayMs = (attempt) => {
    if (attempt <= 0) return 0;
    const expo =
      reconnectPolicy.initialDelayMs * reconnectPolicy.factor ** (attempt - 1);
    const capped = Math.min(reconnectPolicy.maxDelayMs, expo);
    const jitterRange = capped * reconnectPolicy.jitter;
    const randomOffset =
      jitterRange > 0 ? (Math.random() * 2 - 1) * jitterRange : 0;
    return Math.max(0, Math.round(capped + randomOffset));
  };

  const connectHandshake = async () => {
    await transport.connect();
    const outboundMsgId = await send("connect", {
      token,
      client_id: clientId,
    });
    log({ event: "connect_sent", msg_id: outboundMsgId });
    await waitForConnected(reconnectPolicy.handshakeTimeoutMs);
  };

  const runReconnectLoop = async (trigger) => {
    if (!reconnectPolicy.enabled || reconnectInFlight || stopped || !started) {
      return;
    }
    reconnectInFlight = true;

    while (!stopped && started && !connected) {
      if (reconnectAttempts >= reconnectPolicy.maxAttempts) {
        emit("error", {
          code: "reconnect_exhausted",
          message: "Reconnect attempts exhausted",
          details: { attempts: reconnectAttempts },
        });
        break;
      }

      const delayMs = computeReconnectDelayMs(reconnectAttempts);
      if (delayMs > 0) {
        emit("reconnect_scheduled", {
          attempt: reconnectAttempts + 1,
          delayMs,
          trigger,
        });
        await sleep(delayMs);
      }

      if (stopped || !started || connected) break;

      try {
        await connectHandshake();
        reconnectAttempts = 0;
        reconnectInFlight = false;
        return;
      } catch (error) {
        reconnectAttempts += 1;
        log({
          event: "reconnect_attempt_failed",
          attempt: reconnectAttempts,
          trigger,
          message: error instanceof Error ? error.message : String(error),
        });
        try {
          await transport.disconnect();
        } catch {
          // best-effort disconnect before next attempt
        }
      }
    }

    reconnectInFlight = false;
  };

  const handleTransportFailure = async ({
    code,
    message,
    reconnectAllowed,
    emitError = true,
  }) => {
    syncInFlight = false;
    connected = false;
    settleConnectWaiters(false, new Error(message));
    try {
      await transport.disconnect();
    } catch {
      // best-effort disconnect
    }

    if (emitError) {
      emit("error", {
        code,
        message,
        details: {},
      });
    }

    if (reconnectAllowed) {
      void runReconnectLoop(code);
    }
  };

  const withInboundErrorHandling = async (fn) => {
    try {
      await fn();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unexpected client runtime error";
      log({
        event: "handler_error",
        message,
      });
      await handleTransportFailure({
        code: "client_runtime_error",
        message,
        reconnectAllowed: reconnectPolicy.enabled,
        emitError: true,
      });
    }
  };

  const flushDraftQueue = async () => {
    if (!connected || syncInFlight || stopped) return;

    const drafts = await store.loadDraftsOrdered();
    log({
      event: "flush_drafts",
      draft_count: drafts.length,
    });
    for (const draft of drafts) {
      const outboundMsgId = await send("submit_events", {
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
        msg_id: outboundMsgId,
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
    try {
      const outboundMsgId = await send("sync", {
        partitions: activePartitions,
        since_committed_id: since,
        limit: 500,
      });
      log({
        event: "sync_requested",
        partitions: activePartitions,
        since_committed_id: since,
        msg_id: outboundMsgId,
      });
    } catch (error) {
      syncInFlight = false;
      throw error;
    }
  };

  const onConnected = async (payload, messageContext = {}) => {
    connected = true;
    reconnectAttempts = 0;
    settleConnectWaiters(true);
    log({
      event: "connected",
      client_id: payload?.client_id,
      server_last_committed_id: payload?.server_last_committed_id,
      msg_id: messageContext.msgId,
    });
    emit("connected", payload);
    await syncFromCursor();
  };

  const onSubmitResult = async (payload, messageContext = {}) => {
    for (const result of payload.results || []) {
      await store.applySubmitResult({ result, fallbackClientId: clientId });

      if (result.status === "committed") {
        log({
          event: "submit_committed",
          id: result.id,
          committed_id: result.committed_id,
          msg_id: messageContext.msgId,
        });
        emit("committed", result);
      } else {
        log({
          event: "submit_rejected",
          id: result.id,
          reason: result.reason,
          msg_id: messageContext.msgId,
        });
        emit("rejected", result);
      }
    }
  };

  const onSyncResponse = async (payload, messageContext = {}) => {
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
      msg_id: messageContext.msgId,
    });

    if (payload.has_more) {
      try {
        const outboundMsgId = await send("sync", {
          partitions: activePartitions,
          since_committed_id: payload.next_since_committed_id,
          limit: 500,
        });
        log({
          event: "sync_requested",
          partitions: activePartitions,
          since_committed_id: payload.next_since_committed_id,
          msg_id: outboundMsgId,
        });
      } catch (error) {
        syncInFlight = false;
        throw error;
      }
      return;
    }

    syncInFlight = false;
    emit("synced", { cursor: payload.next_since_committed_id });
    log({
      event: "synced",
      cursor: payload.next_since_committed_id,
      msg_id: messageContext.msgId,
    });
    await flushDraftQueue();
  };

  const onBroadcast = async (payload, messageContext = {}) => {
    await store.applyCommittedBatch({ events: [payload] });
    log({
      event: "broadcast_applied",
      id: payload.id,
      committed_id: payload.committed_id,
      msg_id: messageContext.msgId,
    });
    emit("broadcast", payload);
  };

  const onError = async (payload, messageContext = {}) => {
    log({
      event: "error_received",
      code: payload.code,
      msg_id: messageContext.msgId,
    });

    if (
      payload.code === "auth_failed" ||
      payload.code === "protocol_version_unsupported" ||
      payload.code === "server_error"
    ) {
      const reconnectAllowed =
        reconnectPolicy.enabled && payload.code === "server_error";
      await handleTransportFailure({
        code: payload.code,
        message: payload.message || "server error",
        reconnectAllowed,
        emitError: true,
      });
      log({
        event: "transport_disconnected",
        code: payload.code,
        msg_id: messageContext.msgId,
      });
      return;
    }

    emit("error", payload);
  };

  const handleServerMessage = async (message) => {
    if (!isObject(message) || typeof message.type !== "string") {
      emit("error", {
        code: "bad_server_message",
        message: "Server message envelope is invalid",
        details: {},
      });
      return;
    }

    if (message.msg_id !== undefined && typeof message.msg_id !== "string") {
      emit("error", {
        code: "bad_server_message",
        message: "Server message msg_id must be a string",
        details: {},
      });
      return;
    }
    const inboundMsgId =
      typeof message.msg_id === "string" ? message.msg_id : undefined;

    log({
      event: "message_received",
      message_type: message.type,
      msg_id: inboundMsgId,
    });

    switch (message.type) {
      case "connected":
        await onConnected(message.payload, { msgId: inboundMsgId });
        return;
      case "submit_events_result":
        await onSubmitResult(message.payload, { msgId: inboundMsgId });
        return;
      case "sync_response":
        await onSyncResponse(message.payload, { msgId: inboundMsgId });
        return;
      case "event_broadcast":
        await onBroadcast(message.payload, { msgId: inboundMsgId });
        return;
      case "error":
        await onError(message.payload, { msgId: inboundMsgId });
        return;
      default:
        emit("unknown_message", message);
    }
  };

  return {
    start: async () => {
      if (started) return;
      stopped = false;
      started = true;
      try {
        await store.init();
        await transport.connect();
        log({ event: "transport_connected" });
        unsubscribeTransport = transport.onMessage((message) => {
          inboundQueue = inboundQueue
            .catch(() => {})
            .then(() =>
              withInboundErrorHandling(() => handleServerMessage(message)),
            );
        });

        const outboundMsgId = await send("connect", {
          token,
          client_id: clientId,
        });
        log({ event: "connect_sent", msg_id: outboundMsgId });
      } catch (error) {
        await handleTransportFailure({
          code: "transport_connect_failed",
          message:
            error instanceof Error ? error.message : "Transport connect failed",
          reconnectAllowed: reconnectPolicy.enabled,
          emitError: true,
        });
        if (!reconnectPolicy.enabled) {
          started = false;
        }
        throw error;
      }
    },

    stop: async () => {
      if (!started) return;
      stopped = true;
      if (unsubscribeTransport) unsubscribeTransport();
      await transport.disconnect();
      connected = false;
      syncInFlight = false;
      reconnectInFlight = false;
      reconnectAttempts = 0;
      settleConnectWaiters(false, new Error("stopped"));
      started = false;
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
        const outboundMsgId = await send("submit_events", {
          events: [{ id, partitions: eventPartitions, event }],
        });
        log({
          event: "submit_sent",
          id,
          msg_id: outboundMsgId,
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
