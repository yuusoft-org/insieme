const PROTOCOL_VERSION = "1.0";

const isObject = (value) => !!value && typeof value === "object";

const toNonNegativeNumberOr = (value, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    return fallback;
  }
  return value;
};

const ensureTransportShape = (transport) => {
  if (!isObject(transport)) {
    throw new Error("online transport must be an object");
  }
  if (
    typeof transport.connect !== "function" ||
    typeof transport.disconnect !== "function" ||
    typeof transport.send !== "function" ||
    typeof transport.onMessage !== "function"
  ) {
    throw new Error(
      "online transport must implement connect/disconnect/send/onMessage",
    );
  }
};

/**
 * Offline-first transport that can later attach an online transport without replacing the client instance.
 * In offline mode:
 * - connect/sync are answered locally
 * - submit_events are buffered for later replay
 *
 * @param {{
 *   serverLastCommittedId?: number,
 *   maxBufferedSubmits?: number,
 *   onBufferedSubmit?: (entry: { id?: string, bufferedCount: number }) => void
 * }} [options]
 */
export const createOfflineTransport = (options = {}) => {
  const serverLastCommittedId = toNonNegativeNumberOr(
    options.serverLastCommittedId,
    0,
  );
  const maxBufferedSubmits = Number.isInteger(options.maxBufferedSubmits)
    ? Math.max(0, options.maxBufferedSubmits)
    : 10_000;
  const onBufferedSubmit =
    typeof options.onBufferedSubmit === "function"
      ? options.onBufferedSubmit
      : () => {};

  let connected = false;
  /** @type {null|{
   *   connect: () => Promise<void>,
   *   disconnect: () => Promise<void>,
   *   send: (message: object) => Promise<void>,
   *   onMessage: (handler: (message: object) => void) => () => void,
   * }} */
  let onlineTransport = null;
  /** @type {null|(() => void)} */
  let onlineUnsubscribe = null;
  /** @type {null|((message: object) => void)} */
  let onMessageHandler = null;
  /** @type {null|object} */
  let lastConnectMessage = null;
  let waitingForOnlineConnected = false;
  /** @type {object[]} */
  const bufferedSubmits = [];

  const emit = (message) => {
    if (onMessageHandler) {
      onMessageHandler(message);
    }
  };

  const drainBufferedSubmitsToOnline = async () => {
    if (!onlineTransport || bufferedSubmits.length === 0) return;
    while (bufferedSubmits.length > 0) {
      const message = bufferedSubmits.shift();
      await onlineTransport.send(message);
    }
  };

  const attachOnlineListener = () => {
    if (!onlineTransport) return;
    if (onlineUnsubscribe) {
      onlineUnsubscribe();
      onlineUnsubscribe = null;
    }
    onlineUnsubscribe = onlineTransport.onMessage((message) => {
      emit(message);
      if (
        waitingForOnlineConnected &&
        isObject(message) &&
        message.type === "connected"
      ) {
        waitingForOnlineConnected = false;
        void drainBufferedSubmitsToOnline();
      }
    });
  };

  const syncToOnlineIfConnected = async () => {
    if (!connected || !onlineTransport) return;
    await onlineTransport.connect();
    attachOnlineListener();
    if (lastConnectMessage) {
      waitingForOnlineConnected = true;
      await onlineTransport.send(lastConnectMessage);
    } else {
      waitingForOnlineConnected = false;
    }
  };

  return {
    connect: async () => {
      connected = true;
      await syncToOnlineIfConnected();
    },

    disconnect: async () => {
      if (onlineUnsubscribe) {
        onlineUnsubscribe();
        onlineUnsubscribe = null;
      }
      if (onlineTransport) {
        await onlineTransport.disconnect();
      }
      connected = false;
      waitingForOnlineConnected = false;
    },

    send: async (message) => {
      if (!connected) {
        throw new Error("disconnected");
      }

      if (isObject(message) && message.type === "connect") {
        lastConnectMessage = message;
      }

      if (onlineTransport) {
        await onlineTransport.send(message);
        return;
      }

      if (!isObject(message) || typeof message.type !== "string") {
        emit({
          type: "error",
          protocol_version: PROTOCOL_VERSION,
          payload: {
            code: "bad_request",
            message: "Message must be an object with a string type",
            details: {},
          },
        });
        return;
      }

      const msgId =
        typeof message.msg_id === "string" ? message.msg_id : undefined;

      switch (message.type) {
        case "connect": {
          emit({
            type: "connected",
            protocol_version: PROTOCOL_VERSION,
            msg_id: msgId,
            payload: {
              client_id: message.payload?.client_id,
              server_last_committed_id: serverLastCommittedId,
            },
          });
          return;
        }

        case "sync": {
          const nextSinceCommittedId = toNonNegativeNumberOr(
            message.payload?.since_committed_id,
            serverLastCommittedId,
          );
          const partitions = Array.isArray(message.payload?.partitions)
            ? [...message.payload.partitions]
            : [];
          emit({
            type: "sync_response",
            protocol_version: PROTOCOL_VERSION,
            msg_id: msgId,
            payload: {
              partitions,
              events: [],
              next_since_committed_id: nextSinceCommittedId,
              has_more: false,
            },
          });
          return;
        }

        case "submit_events": {
          if (bufferedSubmits.length < maxBufferedSubmits) {
            bufferedSubmits.push(message);
            const firstId = message?.payload?.events?.[0]?.id;
            onBufferedSubmit({
              id: typeof firstId === "string" ? firstId : undefined,
              bufferedCount: bufferedSubmits.length,
            });
          } else {
            emit({
              type: "error",
              protocol_version: PROTOCOL_VERSION,
              msg_id: msgId,
              payload: {
                code: "rate_limited",
                message: "offline buffered submit capacity exceeded",
                details: {
                  max_buffered_submits: maxBufferedSubmits,
                },
              },
            });
          }
          return;
        }

        default: {
          emit({
            type: "error",
            protocol_version: PROTOCOL_VERSION,
            msg_id: msgId,
            payload: {
              code: "bad_request",
              message: `Unknown message type: ${message.type}`,
              details: { offline: true },
            },
          });
        }
      }
    },

    onMessage: (handler) => {
      onMessageHandler = handler;
      if (onlineTransport && connected) {
        attachOnlineListener();
      }
      return () => {
        if (onMessageHandler === handler) {
          onMessageHandler = null;
        }
      };
    },

    setOnlineTransport: async (transport) => {
      ensureTransportShape(transport);
      if (onlineUnsubscribe) {
        onlineUnsubscribe();
        onlineUnsubscribe = null;
      }
      if (onlineTransport && connected) {
        await onlineTransport.disconnect();
      }
      onlineTransport = transport;
      await syncToOnlineIfConnected();
    },

    setOffline: async () => {
      waitingForOnlineConnected = false;
      if (onlineUnsubscribe) {
        onlineUnsubscribe();
        onlineUnsubscribe = null;
      }
      if (onlineTransport && connected) {
        await onlineTransport.disconnect();
      }
      onlineTransport = null;
    },

    getState: () => ({
      connected,
      online: !!onlineTransport,
      waitingForOnlineConnected,
      bufferedSubmitCount: bufferedSubmits.length,
    }),
  };
};
