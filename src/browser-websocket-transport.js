const SOCKET_NOT_CONNECTED_ERROR = "websocket is not connected";

const parseIncoming = (data) => {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  return JSON.parse(String(data));
};

/**
 * @param {{
 *   url: string,
 *   protocols?: string | string[],
 *   WebSocketImpl?: typeof WebSocket,
 *   logger?: (entry: object) => void,
 *   label?: string,
 * }} input
 */
export const createBrowserWebSocketTransport = ({
  url,
  protocols,
  WebSocketImpl = globalThis.WebSocket,
  logger = () => {},
  label = "insieme.browser_ws_transport",
}) => {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("createBrowserWebSocketTransport: url is required");
  }
  if (!WebSocketImpl) {
    throw new Error(
      "createBrowserWebSocketTransport: WebSocket implementation is required",
    );
  }

  let socket = null;
  let messageHandler = null;

  const log = (event, details = {}) => {
    try {
      logger({ component: label, event, url, ...details });
    } catch {
      // logging must not affect transport behavior
    }
  };

  const ensureOpen = () => {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
      throw new Error(SOCKET_NOT_CONNECTED_ERROR);
    }
  };

  const attachMessageHandler = (nextSocket) => {
    nextSocket.onmessage = (wsEvent) => {
      if (!messageHandler) return;
      try {
        const message = parseIncoming(wsEvent.data);
        log("message_received", { messageType: message?.type || null });
        messageHandler(message);
      } catch (error) {
        log("message_parse_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  };

  return {
    connect: async () => {
      if (socket && socket.readyState === WebSocketImpl.OPEN) {
        log("connect_skipped_already_open");
        return;
      }

      const current = socket;
      if (current && current.readyState === WebSocketImpl.CONNECTING) {
        log("connect_wait_existing_connecting_socket");
        await new Promise((resolve, reject) => {
          const onOpen = () => {
            current.removeEventListener("error", onError);
            resolve();
          };
          const onError = () => {
            current.removeEventListener("open", onOpen);
            reject(new Error("websocket connect failed"));
          };
          current.addEventListener("open", onOpen, { once: true });
          current.addEventListener("error", onError, { once: true });
        });
        return;
      }

      log("connect_attempt");
      await new Promise((resolve, reject) => {
        const nextSocket = new WebSocketImpl(url, protocols);
        socket = nextSocket;
        attachMessageHandler(nextSocket);
        nextSocket.onclose = (event) => {
          log("socket_closed", {
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
          });
        };
        nextSocket.onopen = () => {
          log("connected");
          resolve();
        };
        nextSocket.onerror = () => {
          log("connect_failed");
          reject(new Error("websocket connect failed"));
        };
      });
    },

    disconnect: async () => {
      if (!socket) return;
      const current = socket;
      socket = null;

      if (
        current.readyState === WebSocketImpl.CLOSING ||
        current.readyState === WebSocketImpl.CLOSED
      ) {
        return;
      }

      await new Promise((resolve) => {
        current.onclose = (event) => {
          log("disconnected", {
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
          });
          resolve();
        };
        current.close();
      });
    },

    send: async (message) => {
      ensureOpen();
      socket.send(JSON.stringify(message));
      log("message_sent", { messageType: message?.type || null });
    },

    onMessage: (handler) => {
      messageHandler = handler;
      if (socket) {
        attachMessageHandler(socket);
      }
      return () => {
        if (messageHandler === handler) {
          messageHandler = null;
        }
      };
    },
  };
};
