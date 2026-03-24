import {
  isNonEmptyString,
  normalizeMeta,
  toFiniteNumberOrNull,
  toPositiveIntegerOrNull,
} from "./event-record.js";

const PROTOCOL_VERSION = "1.0";
const DEFAULT_SYNC_LIMIT = 500;
const MAX_SYNC_LIMIT = 1000;
const DEFAULT_RATE_WINDOW_MS = 1000;
const DEFAULT_MAX_INBOUND_MESSAGES_PER_WINDOW = 200;
const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024;

/**
 * @param {object} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => !!value && typeof value === "object";

/**
 * @param {unknown} value
 * @returns {number}
 */
const toNumberOr = (value, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return value;
};

const toPositiveIntOr = (value, fallback) => {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
};

/**
 * @param {string} partition
 * @param {string} [path]
 * @returns {{ ok: true, value: string } | { ok: false, code: string, message: string }}
 */
const validateEventPartition = (
  partition,
  path = "payload.events[].partition",
) => {
  if (typeof partition !== "string" || partition.length === 0) {
    return {
      ok: false,
      code: "bad_request",
      message: `${path} must be a non-empty string`,
    };
  }
  return { ok: true, value: partition };
};

/**
 * @param {string} projectId
 * @returns {{ ok: true, value: string } | { ok: false, code: string, message: string }}
 */
const validateProjectId = (projectId, path = "payload.projectId") => {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return {
      ok: false,
      code: "bad_request",
      message: `${path} must be a non-empty string`,
    };
  }
  return { ok: true, value: projectId };
};

/**
 * @param {{ send: (message: object) => Promise<void> }} transport
 * @param {string} type
 * @param {object} payload
 */
const sendMessage = async (transport, type, payload, options = {}) => {
  const envelope = {
    type,
    protocolVersion: PROTOCOL_VERSION,
    payload,
  };
  if (typeof options.msgId === "string") {
    envelope.msgId = options.msgId;
  }
  await transport.send(envelope);
};

/**
 * @param {{ send: (message: object) => Promise<void> }} transport
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
const sendError = async (
  transport,
  code,
  message,
  details = {},
  options = {},
) => {
  await sendMessage(
    transport,
    "error",
    {
      code,
      message,
      details,
    },
    options,
  );
};

/**
 * @param {unknown} reason
 * @param {string} fallbackCode
 * @param {string} fallbackMessage
 */
const toErrorPayload = (reason, fallbackCode, fallbackMessage) => {
  if (!isObject(reason)) {
    return { code: fallbackCode, message: fallbackMessage, details: {} };
  }

  const rawCode = reason.code;
  const rawMessage = reason.message;
  const details = isObject(reason.details) ? reason.details : {};

  return {
    code: typeof rawCode === "string" ? rawCode : fallbackCode,
    message: typeof rawMessage === "string" ? rawMessage : fallbackMessage,
    details,
  };
};

/**
 * @param {{
 *   auth: {
 *     verifyToken: (token: string) => Promise<{ clientId: string, claims: object }>,
 *     validateSession?: (identity: { clientId: string, claims: object }) => Promise<boolean>,
 *   },
 *   authz: { authorizeProject: (identity: object, projectId: string) => Promise<boolean> },
 *   validation: { validate: (item: object, ctx: object) => Promise<void> },
 *   store: {
 *     commitOrGetExisting: (input: { id: string, partition: string, projectId?: string, userId?: string, type: string, schemaVersion: number, payload: object, meta: object, now: number }) => Promise<{ deduped: boolean, committedEvent: { id: string, partition: string, projectId?: string, userId?: string, type: string, schemaVersion: number, payload: object, meta: object, committedId: number, serverTs: number } }>,
 *     listCommittedSince: (input: { projectId: string, sinceCommittedId: number, limit: number, syncToCommittedId?: number }) => Promise<{ events: object[], hasMore: boolean, nextSinceCommittedId: number }>,
 *     getMaxCommittedIdForProject: (input: { projectId: string }) => Promise<number>,
 *     getMaxCommittedId: () => Promise<number>,
 *   },
 *   clock: { now: () => number },
 *   logger?: (entry: object) => void,
 *   limits?: {
 *     maxInboundMessagesPerWindow?: number,
 *     rateWindowMs?: number,
 *     maxEnvelopeBytes?: number,
 *     closeOnRateLimit?: boolean,
 *     closeOnOversize?: boolean,
 *   },
 * }} deps
 */
export const createSyncServer = ({
  auth,
  authz,
  validation,
  store,
  clock,
  logger = () => {},
  limits = {},
}) => {
  /** @type {Map<string, {
   *   transport: { connectionId: string, send: (message: object) => Promise<void>, close: (code?: number, reason?: string) => Promise<void> },
   *   state: "await_connect"|"active"|"closed",
   *   identity: null|{ clientId: string, claims: object },
   *   activeProjectId: null|string,
   *   syncInProgress: boolean,
   *   syncToCommittedId: null|number,
   *   rateWindowStartedAt: number,
   *   rateWindowCount: number,
   * }>} */
  const sessions = new Map();
  const inboundLimits = {
    maxInboundMessagesPerWindow: toPositiveIntOr(
      limits.maxInboundMessagesPerWindow,
      DEFAULT_MAX_INBOUND_MESSAGES_PER_WINDOW,
    ),
    rateWindowMs: toPositiveIntOr(limits.rateWindowMs, DEFAULT_RATE_WINDOW_MS),
    maxEnvelopeBytes: toPositiveIntOr(
      limits.maxEnvelopeBytes,
      DEFAULT_MAX_ENVELOPE_BYTES,
    ),
    closeOnRateLimit: limits.closeOnRateLimit !== false,
    closeOnOversize: limits.closeOnOversize !== false,
  };
  let nextServerMsgId = 1;
  const validateSession =
    typeof auth.validateSession === "function" ? auth.validateSession : null;
  const log = (entry) => {
    try {
      logger({ component: "sync_server", ...entry });
    } catch {
      // logging must not affect protocol flow
    }
  };
  const createServerMsgId = () => {
    const msgId = `srv-${nextServerMsgId}`;
    nextServerMsgId += 1;
    return msgId;
  };

  const closeSession = async (connectionId, reason) => {
    const session = sessions.get(connectionId);
    if (!session) return;
    session.state = "closed";
    sessions.delete(connectionId);
    await session.transport.close(undefined, reason);
    log({
      event: "session_closed",
      connectionId,
      reason,
    });
  };

  const isSupportedVersion = (version) => version === PROTOCOL_VERSION;

  const ensureSessionAuthorized = async (session, msgId) => {
    if (!validateSession || !session.identity) return true;

    let authorized = false;
    try {
      authorized = (await validateSession(session.identity)) === true;
    } catch {
      authorized = false;
    }

    if (authorized) return true;

    await sendError(
      session.transport,
      "auth_failed",
      "Session is no longer authorized",
      {},
      { msgId },
    );
    log({
      event: "session_auth_failed",
      connectionId: session.transport.connectionId,
      clientId: session.identity.clientId,
      msgId: msgId,
    });
    await closeSession(session.transport.connectionId, "auth_failed");
    return false;
  };

  const getApproxEnvelopeBytes = (message) => {
    try {
      return Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const enforceInboundGuards = async (session, message, msgId) => {
    const now = clock.now();

    if (
      session.rateWindowStartedAt === 0 ||
      now - session.rateWindowStartedAt >= inboundLimits.rateWindowMs
    ) {
      session.rateWindowStartedAt = now;
      session.rateWindowCount = 0;
    }
    session.rateWindowCount += 1;

    if (session.rateWindowCount > inboundLimits.maxInboundMessagesPerWindow) {
      await sendError(
        session.transport,
        "rate_limited",
        "Inbound message rate limit exceeded",
        {
          maxMessagesPerWindow: inboundLimits.maxInboundMessagesPerWindow,
          windowMs: inboundLimits.rateWindowMs,
        },
        { msgId },
      );
      log({
        event: "rate_limited",
        connectionId: session.transport.connectionId,
        msgId: msgId,
        maxMessagesPerWindow: inboundLimits.maxInboundMessagesPerWindow,
        windowMs: inboundLimits.rateWindowMs,
      });
      if (inboundLimits.closeOnRateLimit) {
        await closeSession(session.transport.connectionId, "rate_limited");
      }
      return false;
    }

    const envelopeBytes = getApproxEnvelopeBytes(message);
    if (envelopeBytes > inboundLimits.maxEnvelopeBytes) {
      await sendError(
        session.transport,
        "bad_request",
        "Message exceeds maximum envelope size",
        {
          maxEnvelopeBytes: inboundLimits.maxEnvelopeBytes,
          actualEnvelopeBytes: envelopeBytes,
        },
        { msgId },
      );
      log({
        event: "message_too_large",
        connectionId: session.transport.connectionId,
        msgId: msgId,
        maxEnvelopeBytes: inboundLimits.maxEnvelopeBytes,
        actualEnvelopeBytes: envelopeBytes,
      });
      if (inboundLimits.closeOnOversize) {
        await closeSession(session.transport.connectionId, "message_too_large");
      }
      return false;
    }

    return true;
  };

  const handleConnect = async (session, payload, context = {}) => {
    if (!isObject(payload)) {
      await sendError(
        session.transport,
        "bad_request",
        "Missing connect payload",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const token = payload.token;
    const clientId = payload.clientId;
    const projectIdCheck = validateProjectId(
      payload.projectId,
      "connect.payload.projectId",
    );

    if (
      typeof token !== "string" ||
      typeof clientId !== "string" ||
      !projectIdCheck.ok
    ) {
      await sendError(
        session.transport,
        "bad_request",
        projectIdCheck.ok
          ? "connect.payload.token and connect.payload.clientId are required"
          : projectIdCheck.message,
        {},
        { msgId: context.msgId },
      );
      return;
    }

    let identity;
    try {
      identity = await auth.verifyToken(token);
    } catch {
      await sendError(
        session.transport,
        "auth_failed",
        "Authentication failed",
        {},
        { msgId: context.msgId },
      );
      await closeSession(session.transport.connectionId, "auth_failed");
      return;
    }

    if (!identity || identity.clientId !== clientId) {
      await sendError(
        session.transport,
        "auth_failed",
        "Authenticated identity mismatch",
        {},
        { msgId: context.msgId },
      );
      await closeSession(session.transport.connectionId, "auth_failed");
      return;
    }

    const projectId = projectIdCheck.value;
    const authorized = await authz.authorizeProject(identity, projectId);
    if (!authorized) {
      await sendError(
        session.transport,
        "forbidden",
        "project access denied",
        {},
        { msgId: context.msgId },
      );
      await closeSession(session.transport.connectionId, "forbidden");
      return;
    }

    session.state = "active";
    session.identity = identity;
    session.activeProjectId = projectId;
    log({
      event: "connected",
      connectionId: session.transport.connectionId,
      clientId: clientId,
      projectId,
      msgId: context.msgId,
    });

    const maxCommittedId = await store.getMaxCommittedIdForProject({
      projectId,
    });
    await sendMessage(
      session.transport,
      "connected",
      {
        clientId: clientId,
        projectId,
        projectLastCommittedId: maxCommittedId,
      },
      { msgId: context.msgId },
    );
  };

  const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
    const recipients = [...sessions.values()].filter(
      (session) =>
        session.state === "active" &&
        session.transport.connectionId !== originConnectionId &&
        !session.syncInProgress &&
        session.activeProjectId === committedEvent.projectId,
    );

    for (const session of recipients) {
      const broadcastMsgId = createServerMsgId();
      await sendMessage(session.transport, "event_broadcast", committedEvent, {
        msgId: broadcastMsgId,
      });
      log({
        event: "broadcast_sent",
        connectionId: session.transport.connectionId,
        id: committedEvent.id,
        committedId: committedEvent.committedId,
        msgId: broadcastMsgId,
      });
    }
  };

  const handleSubmit = async (session, payload, context = {}) => {
    if (!session.identity) {
      await sendError(
        session.transport,
        "auth_failed",
        "Unauthenticated session",
        {},
        { msgId: context.msgId },
      );
      await closeSession(session.transport.connectionId, "auth_failed");
      return;
    }

    if (!isObject(payload) || !Array.isArray(payload.events)) {
      await sendError(
        session.transport,
        "bad_request",
        "Missing payload.events",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    if (payload.events.length < 1) {
      await sendError(
        session.transport,
        "bad_request",
        "payload.events must contain at least one item",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    for (let index = 0; index < payload.events.length; index += 1) {
      const item = payload.events[index];
      if (!isObject(item)) {
        await sendError(
          session.transport,
          "bad_request",
          `events[${index}] must be an object`,
          {},
          { msgId: context.msgId },
        );
        return;
      }
      if (!isNonEmptyString(item.id)) {
        await sendError(
          session.transport,
          "bad_request",
          `events[${index}].id is required`,
          {},
          { msgId: context.msgId },
        );
        return;
      }
    }

    const claimsUserId = isNonEmptyString(session.identity?.claims?.userId)
      ? session.identity.claims.userId
      : undefined;
    /** @type {object[]} */
    const results = [];
    /** @type {object[]} */
    const committedEvents = [];
    let blockedById = null;

    const pushRejected = (id, reason, message) => {
      results.push({
        id,
        status: "rejected",
        reason,
        errors: [{ message }],
        created: clock.now(),
      });
      blockedById = id;
      log({
        event: "submit_rejected",
        connectionId: session.transport.connectionId,
        id,
        reason,
        msgId: context.msgId,
      });
    };

    const pushNotProcessed = (id, blockerId) => {
      results.push({
        id,
        status: "not_processed",
        reason: "prior_item_failed",
        blockedById: blockerId,
        created: clock.now(),
      });
      log({
        event: "submit_not_processed",
        connectionId: session.transport.connectionId,
        id,
        blockedById: blockerId,
        msgId: context.msgId,
      });
    };

    for (let index = 0; index < payload.events.length; index += 1) {
      const item = payload.events[index];
      if (blockedById) {
        pushNotProcessed(item.id, blockedById);
        continue;
      }

      if (!isNonEmptyString(item.type)) {
        pushRejected(
          item.id,
          "validation_failed",
          `events[${index}].type must be a non-empty string`,
        );
        continue;
      }
      if (toPositiveIntegerOrNull(item.schemaVersion) === null) {
        pushRejected(
          item.id,
          "validation_failed",
          `events[${index}].schemaVersion must be a positive integer`,
        );
        continue;
      }
      if (!isObject(item.payload)) {
        pushRejected(
          item.id,
          "validation_failed",
          `events[${index}].payload must be an object`,
        );
        continue;
      }

      const partitionCheck = validateEventPartition(
        item.partition,
        `events[${index}].partition`,
      );
      if (!partitionCheck.ok) {
        pushRejected(item.id, partitionCheck.code, partitionCheck.message);
        continue;
      }

      const normalizedPartition = partitionCheck.value;
      const normalizedMeta = normalizeMeta(item.meta, {
        defaultClientId: session.identity.clientId,
      });

      if (!isNonEmptyString(normalizedMeta.clientId)) {
        pushRejected(item.id, "validation_failed", "meta.clientId is required");
        continue;
      }
      if (normalizedMeta.clientId !== session.identity.clientId) {
        pushRejected(
          item.id,
          "forbidden",
          "meta.clientId must match authenticated client",
        );
        continue;
      }
      if (toFiniteNumberOrNull(normalizedMeta.clientTs) === null) {
        pushRejected(
          item.id,
          "validation_failed",
          "meta.clientTs must be a finite number",
        );
        continue;
      }
      if (item.userId !== undefined && !isNonEmptyString(item.userId)) {
        pushRejected(
          item.id,
          "validation_failed",
          "userId must be a non-empty string when provided",
        );
        continue;
      }
      if (
        claimsUserId &&
        isNonEmptyString(item.userId) &&
        item.userId !== claimsUserId
      ) {
        pushRejected(
          item.id,
          "forbidden",
          "userId must match authenticated user",
        );
        continue;
      }

      if (!isNonEmptyString(item.projectId)) {
        pushRejected(item.id, "validation_failed", "projectId is required");
        continue;
      }
      if (item.projectId !== session.activeProjectId) {
        pushRejected(
          item.id,
          "forbidden",
          "projectId must match authenticated session project",
        );
        continue;
      }

      const authorized = await authz.authorizeProject(
        session.identity,
        item.projectId,
      );
      if (!authorized) {
        pushRejected(item.id, "forbidden", "project access denied");
        continue;
      }

      const normalizedItem = {
        id: item.id,
        partition: normalizedPartition,
        projectId: isNonEmptyString(item.projectId) ? item.projectId : undefined,
        userId: isNonEmptyString(item.userId) ? item.userId : undefined,
        type: item.type,
        schemaVersion: item.schemaVersion,
        payload: item.payload,
        meta: normalizedMeta,
      };

      try {
        await validation.validate(normalizedItem, {
          identity: session.identity,
          now: clock.now(),
        });
      } catch (err) {
        const payloadError = toErrorPayload(
          err,
          "validation_failed",
          "submit validation failed",
        );
        pushRejected(
          item.id,
          payloadError.code === "forbidden" ? "forbidden" : "validation_failed",
          payloadError.message,
        );
        continue;
      }

      try {
        const { deduped, committedEvent } = await store.commitOrGetExisting({
          ...normalizedItem,
          now: clock.now(),
        });
        results.push({
          id: committedEvent.id,
          status: "committed",
          committedId: committedEvent.committedId,
          serverTs: committedEvent.serverTs,
        });
        committedEvents.push(committedEvent);
        log({
          event: "submit_committed",
          connectionId: session.transport.connectionId,
          id: committedEvent.id,
          committedId: committedEvent.committedId,
          partition: committedEvent.partition,
          deduped,
          msgId: context.msgId,
        });
      } catch (err) {
        const code =
          isObject(err) && typeof err.code === "string" ? err.code : null;
        if (code === "validation_failed" || code === "forbidden") {
          const payloadError = toErrorPayload(
            err,
            "validation_failed",
            "submit validation failed",
          );
          pushRejected(
            item.id,
            payloadError.code === "forbidden" ? "forbidden" : "validation_failed",
            payloadError.message,
          );
          continue;
        }

        throw err;
      }
    }

    await sendMessage(
      session.transport,
      "submit_events_result",
      {
        results,
      },
      { msgId: context.msgId },
    );

    for (const committedEvent of committedEvents) {
      await broadcastCommitted({
        originConnectionId: session.transport.connectionId,
        committedEvent,
      });
    }
  };

  const handleSync = async (session, payload, context = {}) => {
    if (!session.identity) {
      await sendError(
        session.transport,
        "auth_failed",
        "Unauthenticated session",
        {},
        { msgId: context.msgId },
      );
      await closeSession(session.transport.connectionId, "auth_failed");
      return;
    }

    if (!isObject(payload)) {
      await sendError(
        session.transport,
        "bad_request",
        "Missing sync payload",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const projectIdCheck = validateProjectId(
      payload.projectId,
      "sync.payload.projectId",
    );
    if (!projectIdCheck.ok) {
      await sendError(
        session.transport,
        projectIdCheck.code,
        projectIdCheck.message,
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const normalizedProjectId = projectIdCheck.value;
    if (normalizedProjectId !== session.activeProjectId) {
      await sendError(
        session.transport,
        "forbidden",
        "project access denied",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const rawSince = payload.sinceCommittedId;
    if (
      typeof rawSince !== "number" ||
      Number.isNaN(rawSince) ||
      rawSince < 0
    ) {
      await sendError(
        session.transport,
        "bad_request",
        "sync.payload.sinceCommittedId must be a non-negative number",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const limit = Math.max(
      1,
      Math.min(MAX_SYNC_LIMIT, toNumberOr(payload.limit, DEFAULT_SYNC_LIMIT)),
    );

    session.activeProjectId = normalizedProjectId;
    session.syncInProgress = true;

    if (session.syncToCommittedId === null) {
      session.syncToCommittedId = await store.getMaxCommittedIdForProject({
        projectId: normalizedProjectId,
      });
    }
    log({
      event: "sync_started",
      connectionId: session.transport.connectionId,
      projectId: normalizedProjectId,
      sinceCommittedId: rawSince,
      limit,
      syncToCommittedId: session.syncToCommittedId,
      msgId: context.msgId,
    });

    const page = await store.listCommittedSince({
      projectId: normalizedProjectId,
      sinceCommittedId: rawSince,
      limit,
      syncToCommittedId: session.syncToCommittedId,
    });

    await sendMessage(
      session.transport,
      "sync_response",
      {
        projectId: normalizedProjectId,
        events: page.events,
        nextSinceCommittedId: page.nextSinceCommittedId,
        hasMore: page.hasMore,
        syncToCommittedId: session.syncToCommittedId,
      },
      { msgId: context.msgId },
    );
    log({
      event: "sync_page_sent",
      connectionId: session.transport.connectionId,
      projectId: normalizedProjectId,
      eventCount: page.events.length,
      nextSinceCommittedId: page.nextSinceCommittedId,
      hasMore: page.hasMore,
      msgId: context.msgId,
    });

    if (!page.hasMore) {
      session.syncInProgress = false;
      session.syncToCommittedId = null;
    }
  };

  const handleMessage = async (session, message) => {
    if (session.state === "closed") return;

    const contextMsgId =
      isObject(message) && typeof message.msgId === "string"
        ? message.msgId
        : undefined;
    const allowed = await enforceInboundGuards(session, message, contextMsgId);
    if (!allowed) return;

    if (!isObject(message)) {
      await sendError(
        session.transport,
        "bad_request",
        "Message must be an object",
        {},
        { msgId: contextMsgId },
      );
      return;
    }

    const type = message.type;
    const payload = message.payload;
    const protocolVersion = message.protocolVersion;
    const msgId = message.msgId;
    const parsedMsgId = typeof msgId === "string" ? msgId : undefined;

    if (typeof type !== "string" || !isObject(payload)) {
      await sendError(
        session.transport,
        "bad_request",
        "Missing required envelope fields",
        {},
        { msgId: parsedMsgId },
      );
      return;
    }
    if (msgId !== undefined && typeof msgId !== "string") {
      await sendError(
        session.transport,
        "bad_request",
        "msgId must be a string when provided",
      );
      return;
    }

    log({
      event: "message_received",
      connectionId: session.transport.connectionId,
      messageType: type,
      msgId: parsedMsgId,
    });

    if (!isSupportedVersion(protocolVersion)) {
      await sendError(
        session.transport,
        "protocolVersion_unsupported",
        "Unsupported protocol version",
        {},
        { msgId: parsedMsgId },
      );
      await closeSession(
        session.transport.connectionId,
        "protocolVersion_unsupported",
      );
      return;
    }

    if (session.state === "await_connect") {
      if (type !== "connect") {
        await sendError(
          session.transport,
          "bad_request",
          "Only connect is allowed before handshake",
          {},
          { msgId: parsedMsgId },
        );
        return;
      }

      await handleConnect(session, payload, { msgId: parsedMsgId });
      return;
    }

    if (session.state !== "active") return;
    const sessionAuthorized = await ensureSessionAuthorized(
      session,
      parsedMsgId,
    );
    if (!sessionAuthorized) return;

    switch (type) {
      case "submit_events":
        await handleSubmit(session, payload, { msgId: parsedMsgId });
        return;
      case "sync":
        await handleSync(session, payload, { msgId: parsedMsgId });
        return;
      default:
        await sendError(
          session.transport,
          "bad_request",
          `Unknown message type: ${type}`,
          {},
          { msgId: parsedMsgId },
        );
        log({
          event: "bad_request",
          connectionId: session.transport.connectionId,
          messageType: type,
          msgId: parsedMsgId,
        });
    }
  };

  return {
    attachConnection: (transport) => {
      const session = {
        transport,
        state: "await_connect",
        identity: null,
        activeProjectId: null,
        syncInProgress: false,
        syncToCommittedId: null,
        rateWindowStartedAt: 0,
        rateWindowCount: 0,
      };
      /** @type {Promise<void>} */
      let receiveQueue = Promise.resolve();
      sessions.set(transport.connectionId, session);

      return {
        receive: async (message) => {
          receiveQueue = receiveQueue
            .catch(() => {})
            .then(async () => {
              const inboundMsgId =
                isObject(message) && typeof message.msgId === "string"
                  ? message.msgId
                  : undefined;
              try {
                await handleMessage(session, message);
              } catch {
                await sendError(
                  session.transport,
                  "server_error",
                  "Unexpected server error",
                  {},
                  { msgId: inboundMsgId },
                );
                log({
                  event: "server_error",
                  connectionId: session.transport.connectionId,
                  msgId: inboundMsgId,
                });
                await closeSession(session.transport.connectionId, "server_error");
              }
            });
          return receiveQueue;
        },
        close: async (reason = "closed") => {
          await closeSession(session.transport.connectionId, reason);
        },
      };
    },
    shutdown: async () => {
      const ids = [...sessions.keys()];
      for (const connectionId of ids) {
        await closeSession(connectionId, "shutdown");
      }
    },
  };
};
