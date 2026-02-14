import { intersectsPartitions, normalizePartitionSet } from "./canonicalize.js";

const PROTOCOL_VERSION = "1.0";
const DEFAULT_SYNC_LIMIT = 500;
const MAX_SYNC_LIMIT = 1000;

/**
 * @param {object} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => !!value && typeof value === "object";

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * @param {unknown} value
 * @returns {number}
 */
const toNumberOr = (value, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return value;
};

/**
 * @param {string[]} partitions
 * @returns {{ ok: true, value: string[] } | { ok: false, code: string, message: string }}
 */
const validateEventPartitions = (partitions) => {
  if (!isStringArray(partitions) || partitions.length === 0) {
    return {
      ok: false,
      code: "bad_request",
      message: "payload.events[0].partitions must be a non-empty string array",
    };
  }

  for (const entry of partitions) {
    if (entry.length === 0) {
      return {
        ok: false,
        code: "validation_failed",
        message: "partitions entries must be non-empty strings",
      };
    }
  }

  const normalized = normalizePartitionSet(partitions);
  if (normalized.length !== partitions.length) {
    return {
      ok: false,
      code: "validation_failed",
      message: "duplicate partition values are not allowed",
    };
  }

  return { ok: true, value: normalized };
};

/**
 * @param {string[]} partitions
 * @returns {{ ok: true, value: string[] } | { ok: false, code: string, message: string }}
 */
const validateSyncPartitions = (partitions) => {
  if (!isStringArray(partitions) || partitions.length === 0) {
    return {
      ok: false,
      code: "bad_request",
      message: "payload.partitions must be a non-empty string array",
    };
  }

  for (const entry of partitions) {
    if (entry.length === 0) {
      return {
        ok: false,
        code: "bad_request",
        message: "payload.partitions entries must be non-empty strings",
      };
    }
  }

  return { ok: true, value: normalizePartitionSet(partitions) };
};

/**
 * @param {{ send: (message: object) => Promise<void> }} transport
 * @param {string} type
 * @param {object} payload
 */
const sendMessage = async (transport, type, payload, options = {}) => {
  const envelope = {
    type,
    protocol_version: PROTOCOL_VERSION,
    payload,
  };
  if (typeof options.msgId === "string") {
    envelope.msg_id = options.msgId;
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
 *   auth: { verifyToken: (token: string) => Promise<{ clientId: string, claims: object }> },
 *   authz: { authorizePartitions: (identity: object, partitions: string[]) => Promise<boolean> },
 *   validation: { validate: (item: object, ctx: object) => Promise<void> },
 *   store: {
 *     commitOrGetExisting: (input: { id: string, clientId: string, partitions: string[], event: object, now: number }) => Promise<{ deduped: boolean, committedEvent: { id: string, client_id: string, partitions: string[], committed_id: number, event: object, status_updated_at: number } }>,
 *     listCommittedSince: (input: { partitions: string[], sinceCommittedId: number, limit: number, syncToCommittedId?: number }) => Promise<{ events: object[], hasMore: boolean, nextSinceCommittedId: number }>,
 *     getMaxCommittedId: () => Promise<number>,
 *   },
 *   clock: { now: () => number },
 *   logger?: (entry: object) => void,
 * }} deps
 */
export const createSyncServer = ({
  auth,
  authz,
  validation,
  store,
  clock,
  logger = () => {},
}) => {
  /** @type {Map<string, {
   *   transport: { connectionId: string, send: (message: object) => Promise<void>, close: (code?: number, reason?: string) => Promise<void> },
   *   state: "await_connect"|"active"|"closed",
   *   identity: null|{ clientId: string, claims: object },
   *   activePartitions: string[],
   *   syncInProgress: boolean,
   *   syncToCommittedId: null|number,
   * }>} */
  const sessions = new Map();
  let nextServerMsgId = 1;
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
      connection_id: connectionId,
      reason,
    });
  };

  const isSupportedVersion = (version) => version === PROTOCOL_VERSION;

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
    const clientId = payload.client_id;

    if (typeof token !== "string" || typeof clientId !== "string") {
      await sendError(
        session.transport,
        "bad_request",
        "connect.payload.token and connect.payload.client_id are required",
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

    session.state = "active";
    session.identity = identity;
    log({
      event: "connected",
      connection_id: session.transport.connectionId,
      client_id: clientId,
      msg_id: context.msgId,
    });

    const maxCommittedId = await store.getMaxCommittedId();
    await sendMessage(
      session.transport,
      "connected",
      {
        client_id: clientId,
        server_last_committed_id: maxCommittedId,
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
        intersectsPartitions(
          session.activePartitions,
          committedEvent.partitions,
        ),
    );

    for (const session of recipients) {
      const broadcastMsgId = createServerMsgId();
      await sendMessage(session.transport, "event_broadcast", committedEvent, {
        msgId: broadcastMsgId,
      });
      log({
        event: "broadcast_sent",
        connection_id: session.transport.connectionId,
        id: committedEvent.id,
        committed_id: committedEvent.committed_id,
        msg_id: broadcastMsgId,
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

    if (payload.events.length !== 1) {
      await sendError(
        session.transport,
        "bad_request",
        "payload.events must contain exactly one item in core mode",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const item = payload.events[0];
    if (!isObject(item)) {
      await sendError(
        session.transport,
        "bad_request",
        "events[0] must be an object",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const id = item.id;
    const partitions = item.partitions;
    const event = item.event;

    if (typeof id !== "string" || id.length === 0) {
      await sendError(
        session.transport,
        "bad_request",
        "events[0].id is required",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    if (!isObject(event)) {
      await sendError(
        session.transport,
        "bad_request",
        "events[0].event is required",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const partitionCheck = validateEventPartitions(partitions);
    if (!partitionCheck.ok) {
      await sendMessage(
        session.transport,
        "submit_events_result",
        {
          results: [
            {
              id,
              status: "rejected",
              reason: partitionCheck.code,
              errors: [{ message: partitionCheck.message }],
              status_updated_at: clock.now(),
            },
          ],
        },
        { msgId: context.msgId },
      );
      log({
        event: "submit_rejected",
        connection_id: session.transport.connectionId,
        id,
        reason: partitionCheck.code,
        msg_id: context.msgId,
      });
      return;
    }

    const normalizedPartitions = partitionCheck.value;

    const authorized = await authz.authorizePartitions(
      session.identity,
      normalizedPartitions,
    );
    if (!authorized) {
      await sendMessage(
        session.transport,
        "submit_events_result",
        {
          results: [
            {
              id,
              status: "rejected",
              reason: "forbidden",
              errors: [{ message: "partition access denied" }],
              status_updated_at: clock.now(),
            },
          ],
        },
        { msgId: context.msgId },
      );
      log({
        event: "submit_rejected",
        connection_id: session.transport.connectionId,
        id,
        reason: "forbidden",
        msg_id: context.msgId,
      });
      return;
    }

    try {
      await validation.validate(
        {
          id,
          clientId: session.identity.clientId,
          partitions: normalizedPartitions,
          event,
          createdAt: clock.now(),
        },
        { identity: session.identity },
      );
    } catch (err) {
      const payloadError = toErrorPayload(
        err,
        "validation_failed",
        "submit validation failed",
      );

      if (payloadError.code === "bad_request") {
        await sendError(
          session.transport,
          "bad_request",
          payloadError.message,
          {},
          { msgId: context.msgId },
        );
        return;
      }

      await sendMessage(
        session.transport,
        "submit_events_result",
        {
          results: [
            {
              id,
              status: "rejected",
              reason: payloadError.code,
              errors: [{ message: payloadError.message }],
              status_updated_at: clock.now(),
            },
          ],
        },
        { msgId: context.msgId },
      );
      log({
        event: "submit_rejected",
        connection_id: session.transport.connectionId,
        id,
        reason: payloadError.code,
        msg_id: context.msgId,
      });
      return;
    }

    try {
      const { deduped, committedEvent } = await store.commitOrGetExisting({
        id,
        clientId: session.identity.clientId,
        partitions: normalizedPartitions,
        event,
        now: clock.now(),
      });

      await sendMessage(
        session.transport,
        "submit_events_result",
        {
          results: [
            {
              id: committedEvent.id,
              status: "committed",
              committed_id: committedEvent.committed_id,
              status_updated_at: committedEvent.status_updated_at,
            },
          ],
        },
        { msgId: context.msgId },
      );
      log({
        event: "submit_committed",
        connection_id: session.transport.connectionId,
        id: committedEvent.id,
        committed_id: committedEvent.committed_id,
        client_id: committedEvent.client_id,
        deduped,
        msg_id: context.msgId,
      });

      await broadcastCommitted({
        originConnectionId: session.transport.connectionId,
        committedEvent,
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

        await sendMessage(
          session.transport,
          "submit_events_result",
          {
            results: [
              {
                id,
                status: "rejected",
                reason: payloadError.code,
                errors: [{ message: payloadError.message }],
                status_updated_at: clock.now(),
              },
            ],
          },
          { msgId: context.msgId },
        );
        log({
          event: "submit_rejected",
          connection_id: session.transport.connectionId,
          id,
          reason: payloadError.code,
          msg_id: context.msgId,
        });
        return;
      }

      throw err;
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

    const partitionCheck = validateSyncPartitions(payload.partitions);
    if (!partitionCheck.ok) {
      await sendError(
        session.transport,
        partitionCheck.code,
        partitionCheck.message,
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const normalizedPartitions = partitionCheck.value;
    const authorized = await authz.authorizePartitions(
      session.identity,
      normalizedPartitions,
    );
    if (!authorized) {
      await sendError(
        session.transport,
        "forbidden",
        "partition access denied",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const rawSince = payload.since_committed_id;
    if (
      typeof rawSince !== "number" ||
      Number.isNaN(rawSince) ||
      rawSince < 0
    ) {
      await sendError(
        session.transport,
        "bad_request",
        "sync.payload.since_committed_id must be a non-negative number",
        {},
        { msgId: context.msgId },
      );
      return;
    }

    const limit = Math.max(
      1,
      Math.min(MAX_SYNC_LIMIT, toNumberOr(payload.limit, DEFAULT_SYNC_LIMIT)),
    );

    session.activePartitions = normalizedPartitions;
    session.syncInProgress = true;

    if (session.syncToCommittedId === null) {
      session.syncToCommittedId = await store.getMaxCommittedId();
    }
    log({
      event: "sync_started",
      connection_id: session.transport.connectionId,
      partitions: normalizedPartitions,
      since_committed_id: rawSince,
      limit,
      sync_to_committed_id: session.syncToCommittedId,
      msg_id: context.msgId,
    });

    const page = await store.listCommittedSince({
      partitions: normalizedPartitions,
      sinceCommittedId: rawSince,
      limit,
      syncToCommittedId: session.syncToCommittedId,
    });

    await sendMessage(
      session.transport,
      "sync_response",
      {
        partitions: normalizedPartitions,
        events: page.events,
        next_since_committed_id: page.nextSinceCommittedId,
        has_more: page.hasMore,
      },
      { msgId: context.msgId },
    );
    log({
      event: "sync_page_sent",
      connection_id: session.transport.connectionId,
      partitions: normalizedPartitions,
      event_count: page.events.length,
      next_since_committed_id: page.nextSinceCommittedId,
      has_more: page.hasMore,
      msg_id: context.msgId,
    });

    if (!page.hasMore) {
      session.syncInProgress = false;
      session.syncToCommittedId = null;
    }
  };

  const handleMessage = async (session, message) => {
    if (!isObject(message)) {
      await sendError(
        session.transport,
        "bad_request",
        "Message must be an object",
      );
      return;
    }

    const type = message.type;
    const payload = message.payload;
    const protocolVersion = message.protocol_version;
    const msgId = message.msg_id;
    const contextMsgId = typeof msgId === "string" ? msgId : undefined;

    if (typeof type !== "string" || !isObject(payload)) {
      await sendError(
        session.transport,
        "bad_request",
        "Missing required envelope fields",
        {},
        { msgId: contextMsgId },
      );
      return;
    }
    if (msgId !== undefined && typeof msgId !== "string") {
      await sendError(
        session.transport,
        "bad_request",
        "msg_id must be a string when provided",
      );
      return;
    }

    log({
      event: "message_received",
      connection_id: session.transport.connectionId,
      message_type: type,
      msg_id: contextMsgId,
    });

    if (!isSupportedVersion(protocolVersion)) {
      await sendError(
        session.transport,
        "protocol_version_unsupported",
        "Unsupported protocol version",
        {},
        { msgId: contextMsgId },
      );
      await closeSession(
        session.transport.connectionId,
        "protocol_version_unsupported",
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
          { msgId: contextMsgId },
        );
        return;
      }

      await handleConnect(session, payload, { msgId: contextMsgId });
      return;
    }

    if (session.state !== "active") return;

    switch (type) {
      case "submit_events":
        await handleSubmit(session, payload, { msgId: contextMsgId });
        return;
      case "sync":
        await handleSync(session, payload, { msgId: contextMsgId });
        return;
      default:
        await sendError(
          session.transport,
          "bad_request",
          `Unknown message type: ${type}`,
          {},
          { msgId: contextMsgId },
        );
        log({
          event: "bad_request",
          connection_id: session.transport.connectionId,
          message_type: type,
          msg_id: contextMsgId,
        });
    }
  };

  return {
    attachConnection: (transport) => {
      const session = {
        transport,
        state: "await_connect",
        identity: null,
        activePartitions: [],
        syncInProgress: false,
        syncToCommittedId: null,
      };
      sessions.set(transport.connectionId, session);

      return {
        receive: async (message) => {
          const inboundMsgId =
            isObject(message) && typeof message.msg_id === "string"
              ? message.msg_id
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
              connection_id: session.transport.connectionId,
              msg_id: inboundMsgId,
            });
            await closeSession(session.transport.connectionId, "server_error");
          }
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
