import { randomUUID } from "node:crypto";

/**
 * Attach a node `ws` socket to an Insieme sync server connection.
 *
 * @param {{
 *   syncServer: { attachConnection: (transport: { connectionId: string, send: (message: object) => Promise<void>, close: (reason?: string) => Promise<void> }) => { receive: (message: object) => Promise<void>, close: (reason?: string) => Promise<void> } },
 *   ws: {
 *     OPEN: number,
 *     readyState: number,
 *     send: (payload: string) => void,
 *     close: (code?: number, reason?: string) => void,
 *     ping?: () => void,
 *     terminate?: () => void,
 *     on: (event: string, handler: (...args: any[]) => void) => void,
 *     off?: (event: string, handler: (...args: any[]) => void) => void,
 *   },
 *   connectionId?: string,
 *   logger?: (entry: object) => void,
 *   keepAliveIntervalMs?: number,
 * }} input
 */
export const attachWsConnection = ({
  syncServer,
  ws,
  connectionId = randomUUID(),
  logger = () => {},
  keepAliveIntervalMs = 30_000,
}) => {
  if (!syncServer || typeof syncServer.attachConnection !== "function") {
    throw new Error("attachWsConnection: syncServer.attachConnection is required");
  }
  if (!ws || typeof ws.on !== "function" || typeof ws.send !== "function") {
    throw new Error("attachWsConnection: ws socket is required");
  }

  let closed = false;
  // `ws` library convention; we keep this property local to the socket.
  ws.isAlive = true;

  const log = (event, details = {}) => {
    try {
      logger({ component: "ws_server_bridge", event, connectionId, ...details });
    } catch {
      // logging must not affect bridge behavior
    }
  };

  const session = syncServer.attachConnection({
    connectionId,
    send: async (message) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message));
      log("message_sent", { messageType: message?.type || null });
    },
    close: async (reason = "server_close") => {
      if (closed) return;
      closed = true;
      try {
        ws.close(1000, String(reason).slice(0, 123));
      } catch {
        // ignore close failures
      }
    },
  });

  const maybeClearInterval = (timer) => {
    if (timer) {
      clearInterval(timer);
    }
  };

  const keepAliveTimer =
    Number.isInteger(keepAliveIntervalMs) && keepAliveIntervalMs > 0
      ? setInterval(() => {
          if (closed) return;
          if (ws.isAlive === false) {
            if (typeof ws.terminate === "function") {
              ws.terminate();
            } else {
              ws.close(1006, "keepalive_timeout");
            }
            return;
          }
          ws.isAlive = false;
          if (typeof ws.ping === "function") {
            ws.ping();
          }
        }, keepAliveIntervalMs)
      : null;

  const onPong = () => {
    ws.isAlive = true;
  };

  const onMessage = async (raw) => {
    try {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : String(raw);
      const parsed = JSON.parse(text);
      log("message_received", { messageType: parsed?.type || null });
      await session.receive(parsed);
    } catch (error) {
      log("invalid_message", {
        message: error instanceof Error ? error.message : String(error),
      });
      ws.close(1003, "invalid_message");
    }
  };

  const onClose = async () => {
    if (!closed) {
      closed = true;
      try {
        await session.close("socket_closed");
      } catch {
        // best-effort session close
      }
    }
    maybeClearInterval(keepAliveTimer);
    if (typeof ws.off === "function") {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("pong", onPong);
    }
    log("closed");
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("pong", onPong);

  return {
    connectionId,
    close: async (reason = "closed_by_bridge") => {
      if (closed) return;
      closed = true;
      maybeClearInterval(keepAliveTimer);
      if (typeof ws.off === "function") {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("pong", onPong);
      }
      try {
        await session.close(reason);
      } catch {
        // best-effort
      }
    },
  };
};
