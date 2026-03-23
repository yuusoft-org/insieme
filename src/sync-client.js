import {
  isNonEmptyString,
  isObject,
  normalizeSubmitEventInput,
  toPositiveIntegerOrNull,
} from "./event-record.js";

/**
 * @typedef {{
 *   id: string,
 *   partition: string,
 *   projectId: string,
 *   userId?: string,
 *   type: string,
 *   schemaVersion: number,
 *   payload: object,
 *   meta: object,
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
 *     insertDrafts?: (items: SubmitItem[]) => Promise<void>,
 *     loadDraftsOrdered: () => Promise<SubmitItem[]>,
 *     applySubmitResult: (input: { result: object }) => Promise<void>,
 *     applyCommittedBatch: (input: { events: object[], nextCursor?: number }) => Promise<void>,
 *   },
 *   token: string,
 *   clientId: string,
 *   projectId: string,
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
 *   submitBatch?: {
 *     maxEvents?: number,
 *     maxBytes?: number,
 *   },
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export const createSyncClient = ({
  transport,
  store,
  token,
  clientId,
  projectId,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  msgId = () => crypto.randomUUID(),
  validateLocalEvent = () => {},
  onEvent = () => {},
  logger = () => {},
  reconnect = {},
  submitBatch = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  const DEFAULT_MAX_BATCH_EVENTS = 50;
  const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
  const encoder = new TextEncoder();
  const toPositiveIntOr = (value, fallback) =>
    Number.isInteger(value) && value > 0 ? value : fallback;

  const batching = {
    maxEvents: toPositiveIntOr(submitBatch.maxEvents, DEFAULT_MAX_BATCH_EVENTS),
    maxBytes: toPositiveIntOr(submitBatch.maxBytes, DEFAULT_MAX_BATCH_BYTES),
  };

  const isTransportDisconnectedError = (error) => {
    const code = isObject(error) ? error.code : null;
    if (code === "transport_disconnected") return true;
    const message =
      error instanceof Error ? error.message : String(error || "");
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("disconnected") ||
      normalizedMessage.includes("not connected") ||
      normalizedMessage.includes("websocket is not connected")
    );
  };

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
  if (!isNonEmptyString(projectId)) {
    throw new Error("createSyncClient requires projectId");
  }

  const activeProjectId = projectId;
  let lastError = null;
  let reconnectInFlight = false;
  let reconnectAttempts = 0;
  let connectedServerLastCommittedId = null;
  /** @type {null|{ msgId: string, draftIds: string[] }} */
  let submitBatchInFlight = null;
  /** @type {null|(() => void)} */
  let unsubscribeTransport = null;
  /** @type {Promise<void>} */
  let inboundQueue = Promise.resolve();
  /** @type {Promise<{ localRejections: { error: object, result: object }[] }>} */
  let draftFlushQueue = Promise.resolve({ localRejections: [] });
  /** @type {Map<number, { resolve: () => void, reject: (reason?: unknown) => void }>} */
  const connectWaiters = new Map();
  /** @type {Map<string, { seq: number, error: object, result: object }>} */
  const localSubmitRejections = new Map();
  let nextLocalSubmitRejectionSeq = 1;
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
      protocolVersion: "1.0",
      timestamp: now(),
      msgId: outboundMsgId,
      payload,
    });
    return outboundMsgId;
  };

  const toSubmitEnvelopeItem = (draft) => ({
    id: draft.id,
    partition: draft.partition,
    projectId: draft.projectId || activeProjectId,
    userId: draft.userId,
    type: draft.type,
    schemaVersion: draft.schemaVersion,
    payload: draft.payload,
    meta: normalizeSubmitEventInput(
      { meta: draft.meta },
      {
        defaultProjectId: activeProjectId,
        defaultClientId: clientId,
        defaultClientTs: draft.meta?.clientTs,
      },
    ).meta,
  });

  const getApproxSubmitEnvelopeBytes = (events) => {
    try {
      return encoder.encode(
        JSON.stringify({
          type: "submit_events",
          protocolVersion: "1.0",
          msgId: "batch-preview",
          timestamp: now(),
          payload: { events },
        }),
      ).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const buildDraftBatch = (drafts) => {
    /** @type {SubmitItem[]} */
    const selectedDrafts = [];
    /** @type {object[]} */
    const events = [];

    for (const draft of drafts) {
      const nextEvent = toSubmitEnvelopeItem(draft);
      const nextEvents = [...events, nextEvent];
      const exceedsCount = nextEvents.length > batching.maxEvents;
      const exceedsBytes =
        getApproxSubmitEnvelopeBytes(nextEvents) > batching.maxBytes;

      if (events.length === 0 && (exceedsCount || exceedsBytes)) {
        return {
          selectedDrafts: [],
          events: [],
          oversizedDraft: draft,
          oversizedBytes: getApproxSubmitEnvelopeBytes([nextEvent]),
        };
      }

      if (events.length > 0 && (exceedsCount || exceedsBytes)) {
        break;
      }

      selectedDrafts.push(draft);
      events.push(nextEvent);
    }

    return {
      selectedDrafts,
      events,
      oversizedDraft: null,
      oversizedBytes: null,
    };
  };

  const createLocalRejectedResult = ({
    id,
    reason,
    message,
    created,
  }) => ({
    id,
    status: "rejected",
    reason,
    errors: [{ message }],
    created,
  });

  const createSubmitBatchTooLargeError = ({ id, actualBytes }) => {
    const error = new Error(`Draft ${id} exceeds submitBatch.maxBytes`);
    error.code = "submit_batch_too_large";
    error.details = {
      id,
      maxBytes: batching.maxBytes,
      actualBytes,
    };
    return error;
  };

  const rejectDraftLocally = async ({
    draft,
    code,
    reason,
    message,
    details,
  }) => {
    const errorPayload = {
      code,
      message,
      details,
    };
    const result = createLocalRejectedResult({
      id: draft.id,
      reason,
      message,
      created: now(),
    });

    await store.applySubmitResult({ result });
    const seq = nextLocalSubmitRejectionSeq;
    nextLocalSubmitRejectionSeq += 1;
    localSubmitRejections.set(draft.id, {
      seq,
      error: errorPayload,
      result,
    });
    while (localSubmitRejections.size > 100) {
      const oldestKey = localSubmitRejections.keys().next().value;
      if (!oldestKey) break;
      localSubmitRejections.delete(oldestKey);
    }
    lastError = errorPayload;
    log({
      event: "submit_rejected_local",
      id: draft.id,
      code,
      reason,
    });
    emit("error", errorPayload);
    emit("rejected", result);
    return {
      error: errorPayload,
      result,
    };
  };

  const runFlushDraftQueue = async () => {
    /** @type {{ error: object, result: object }[]} */
    const localRejections = [];

    while (connected && !syncInFlight && !stopped && !submitBatchInFlight) {
      const drafts = await store.loadDraftsOrdered();
      log({
        event: "flush_drafts",
        draftCount: drafts.length,
      });
      if (drafts.length === 0) break;

      const {
        selectedDrafts,
        events,
        oversizedDraft,
        oversizedBytes,
      } = buildDraftBatch(drafts);

      if (oversizedDraft) {
        const oversizedError = createSubmitBatchTooLargeError({
          id: oversizedDraft.id,
          actualBytes: oversizedBytes,
        });
        localRejections.push(
          await rejectDraftLocally({
            draft: oversizedDraft,
            code: "submit_batch_too_large",
            reason: "validation_failed",
            message: oversizedError.message,
            details: oversizedError.details,
          }),
        );
        continue;
      }

      if (selectedDrafts.length === 0) break;

      const outboundMsgId = msgId();
      submitBatchInFlight = {
        msgId: outboundMsgId,
        draftIds: selectedDrafts.map((draft) => draft.id),
      };

      try {
        await send(
          "submit_events",
          {
            events,
          },
          { msgId: outboundMsgId },
        );
        log({
          event: "submit_sent",
          id: selectedDrafts.length === 1 ? selectedDrafts[0].id : undefined,
          draftIds: selectedDrafts.map((draft) => draft.id),
          batchSize: selectedDrafts.length,
          msgId: outboundMsgId,
        });
      } catch (error) {
        submitBatchInFlight = null;
        const disconnected = isTransportDisconnectedError(error);
        await handleTransportFailure({
          code: disconnected
            ? "transport_disconnected"
            : "transport_send_failed",
          message:
            error instanceof Error ? error.message : "Transport send failed",
          reconnectAllowed: reconnectPolicy.enabled,
          emitError: true,
        });
      }
      break;
    }

    return { localRejections };
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
      clientId: clientId,
      projectId: activeProjectId,
    });
    log({ event: "connect_sent", msgId: outboundMsgId });
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
    connectedServerLastCommittedId = null;
    submitBatchInFlight = null;
    settleConnectWaiters(false, new Error(message));
    try {
      await transport.disconnect();
    } catch {
      // best-effort disconnect
    }

    if (emitError) {
      lastError = {
        code,
        message,
      };
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
    draftFlushQueue = draftFlushQueue
      .catch(() => ({ localRejections: [] }))
      .then(() => runFlushDraftQueue());
    return draftFlushQueue;
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
        projectId: activeProjectId,
        sinceCommittedId: since,
        limit: 500,
      });
      log({
        event: "sync_requested",
        projectId: activeProjectId,
        sinceCommittedId: since,
        msgId: outboundMsgId,
      });
    } catch (error) {
      syncInFlight = false;
      throw error;
    }
  };

  const onConnected = async (payload, messageContext = {}) => {
    connected = true;
    reconnectAttempts = 0;
    lastError = null;
    connectedServerLastCommittedId = Number.isFinite(
      Number(payload?.projectLastCommittedId),
    )
      ? Math.max(0, Math.floor(Number(payload.projectLastCommittedId)))
      : null;
    settleConnectWaiters(true);
    log({
      event: "connected",
      clientId: payload?.clientId,
      projectId: payload?.projectId,
      projectLastCommittedId: payload?.projectLastCommittedId,
      msgId: messageContext.msgId,
    });
    emit("connected", payload);
    await syncFromCursor();
  };

  const onSubmitResult = async (payload, messageContext = {}) => {
    const pendingMsgId = submitBatchInFlight?.msgId;
    if (
      submitBatchInFlight &&
      messageContext.msgId &&
      pendingMsgId &&
      messageContext.msgId !== pendingMsgId
    ) {
      log({
        event: "submit_result_msgid_mismatch",
        expectedMsgId: pendingMsgId,
        actualMsgId: messageContext.msgId,
      });
    }

    for (const result of payload.results || []) {
      await store.applySubmitResult({ result });

      if (result.status === "committed") {
        log({
          event: "submit_committed",
          id: result.id,
          committedId: result.committedId,
          msgId: messageContext.msgId,
        });
        emit("committed", result);
      } else if (result.status === "rejected") {
        log({
          event: "submit_rejected",
          id: result.id,
          reason: result.reason,
          msgId: messageContext.msgId,
        });
        emit("rejected", result);
      } else if (result.status === "not_processed") {
        log({
          event: "submit_not_processed",
          id: result.id,
          reason: result.reason,
          blockedById: result.blockedById,
          msgId: messageContext.msgId,
        });
        emit("not_processed", result);
      }
    }

    submitBatchInFlight = null;
    await flushDraftQueue();
  };

  const onSyncResponse = async (payload, messageContext = {}) => {
    await store.applyCommittedBatch({
      events: payload.events || [],
      nextCursor: payload.nextSinceCommittedId,
    });

    emit("sync_page", payload);
    log({
      event: "sync_page_applied",
      eventCount: (payload.events || []).length,
      nextSinceCommittedId: payload.nextSinceCommittedId,
      hasMore: payload.hasMore,
      syncToCommittedId: payload.syncToCommittedId,
      msgId: messageContext.msgId,
    });

    if (payload.hasMore) {
      try {
        const outboundMsgId = await send("sync", {
          projectId: activeProjectId,
          sinceCommittedId: payload.nextSinceCommittedId,
          limit: 500,
        });
        log({
          event: "sync_requested",
          projectId: activeProjectId,
          sinceCommittedId: payload.nextSinceCommittedId,
          msgId: outboundMsgId,
        });
      } catch (error) {
        syncInFlight = false;
        throw error;
      }
      return;
    }

    syncInFlight = false;
    emit("synced", { cursor: payload.nextSinceCommittedId });
    log({
      event: "synced",
      cursor: payload.nextSinceCommittedId,
      msgId: messageContext.msgId,
    });
    await flushDraftQueue();
  };

  const onBroadcast = async (payload, messageContext = {}) => {
    await store.applyCommittedBatch({ events: [payload] });
    log({
      event: "broadcast_applied",
      id: payload.id,
      committedId: payload.committedId,
      msgId: messageContext.msgId,
    });
    emit("broadcast", payload);
  };

  const onError = async (payload, messageContext = {}) => {
    lastError = payload || {
      code: "unknown_error",
      message: "Unknown server error",
      details: {},
    };
    log({
      event: "error_received",
      code: payload.code,
      msgId: messageContext.msgId,
    });

    if (
      payload.code === "auth_failed" ||
      payload.code === "protocolVersion_unsupported" ||
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
        msgId: messageContext.msgId,
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

    if (message.msgId !== undefined && typeof message.msgId !== "string") {
      emit("error", {
        code: "bad_server_message",
        message: "Server message msgId must be a string",
        details: {},
      });
      return;
    }
    const inboundMsgId =
      typeof message.msgId === "string" ? message.msgId : undefined;

    log({
      event: "message_received",
      messageType: message.type,
      msgId: inboundMsgId,
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

  const submitEvents = async (inputs) => {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error("submitEvents requires at least one item");
    }

    const seenIds = new Set();
    const drafts = inputs.map((input) => ({
      ...normalizeSubmitEventInput(input, {
        defaultId: uuid(),
        defaultProjectId: activeProjectId,
        defaultClientId: clientId,
        defaultClientTs: now(),
      }),
      createdAt: now(),
    }));

    for (const draft of drafts) {
      if (!isNonEmptyString(draft.id)) {
        throw new Error("submitEvents requires each item to have a non-empty id");
      }
      if (seenIds.has(draft.id)) {
        throw new Error(`submitEvents duplicate id: ${draft.id}`);
      }
      seenIds.add(draft.id);
      if (!isNonEmptyString(draft.partition)) {
        throw new Error("submitEvents requires partition");
      }
      if (!isNonEmptyString(draft.type)) {
        throw new Error("submitEvents requires type");
      }
      if (toPositiveIntegerOrNull(draft.schemaVersion) === null) {
        throw new Error(
          "submitEvents requires schemaVersion as a positive integer",
        );
      }
      if (!isObject(draft.payload)) {
        throw new Error("submitEvents requires payload object");
      }
      validateLocalEvent(draft);
      const singleEventBytes = getApproxSubmitEnvelopeBytes([
        toSubmitEnvelopeItem(draft),
      ]);
      if (singleEventBytes > batching.maxBytes) {
        throw createSubmitBatchTooLargeError({
          id: draft.id,
          actualBytes: singleEventBytes,
        });
      }
    }

    const localRejectionSeqBeforeInsert = nextLocalSubmitRejectionSeq - 1;

    if (typeof store.insertDrafts === "function") {
      await store.insertDrafts(drafts);
    } else {
      /** @type {SubmitItem[]} */
      const insertedDrafts = [];
      try {
        for (const draft of drafts) {
          await store.insertDraft(draft);
          insertedDrafts.push(draft);
        }
      } catch (error) {
        try {
          for (let index = insertedDrafts.length - 1; index >= 0; index -= 1) {
            const insertedDraft = insertedDrafts[index];
            await store.applySubmitResult({
              result: createLocalRejectedResult({
                id: insertedDraft.id,
                reason: "validation_failed",
                message: "Rolled back failed submitEvents batch insert",
                created: now(),
              }),
            });
            log({
              event: "draft_insert_rolled_back",
              id: insertedDraft.id,
            });
          }
        } catch (rollbackError) {
          const rollbackFailure = new Error(
            "submitEvents failed after partial insert and rollback failed",
          );
          rollbackFailure.cause = error;
          rollbackFailure.rollbackError = rollbackError;
          throw rollbackFailure;
        }
        throw error;
      }
    }

    for (const draft of drafts) {
      log({
        event: "draft_inserted",
        id: draft.id,
      });
    }

    await flushDraftQueue();
    const localRejection = drafts
      .map((draft) => localSubmitRejections.get(draft.id))
      .find((entry) => entry && entry.seq > localRejectionSeqBeforeInsert);
    for (const draft of drafts) {
      localSubmitRejections.delete(draft.id);
    }
    if (localRejection) {
      const error = new Error(localRejection.error.message);
      error.code = localRejection.error.code;
      error.details = localRejection.error.details;
      throw error;
    }
    return drafts.map((draft) => draft.id);
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
          clientId: clientId,
          projectId: activeProjectId,
        });
        log({ event: "connect_sent", msgId: outboundMsgId });
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
      connectedServerLastCommittedId = null;
      submitBatchInFlight = null;
      syncInFlight = false;
      reconnectInFlight = false;
      reconnectAttempts = 0;
      settleConnectWaiters(false, new Error("stopped"));
      started = false;
      log({ event: "stopped" });
    },

    submitEvents,

    submitEvent: async (input) => {
      const [draftId] = await submitEvents([input]);
      return draftId;
    },

    syncNow: async (options = {}) => {
      await syncFromCursor(options.sinceCommittedId);
    },

    flushDrafts: async () => {
      await flushDraftQueue();
    },

    getStatus: () => ({
      started,
      stopped,
      connected,
      syncInFlight,
      reconnectInFlight,
      reconnectAttempts,
      connectedServerLastCommittedId,
      activeProjectId,
      lastError: lastError ? { ...lastError } : null,
    }),
  };
};
