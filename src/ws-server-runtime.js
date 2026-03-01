import { attachWsConnection } from "./ws-server-bridge.js";

/**
 * Attach an entire `ws` server instance to Insieme sync server.
 *
 * @param {{
 *   wsServer: {
 *     on: (event: string, handler: (...args: any[]) => void) => void,
 *     off?: (event: string, handler: (...args: any[]) => void) => void,
 *   },
 *   syncServer: { attachConnection: Function },
 *   logger?: (entry: object) => void,
 *   keepAliveIntervalMs?: number,
 * }} input
 */
export const createWsServerRuntime = ({
  wsServer,
  syncServer,
  logger = () => {},
  keepAliveIntervalMs = 30_000,
}) => {
  if (!wsServer || typeof wsServer.on !== "function") {
    throw new Error("createWsServerRuntime: wsServer.on is required");
  }
  if (!syncServer || typeof syncServer.attachConnection !== "function") {
    throw new Error(
      "createWsServerRuntime: syncServer.attachConnection is required",
    );
  }

  let activeConnections = 0;
  const bridges = new Map();

  const log = (event, details = {}) => {
    try {
      logger({ component: "ws_server_runtime", event, ...details });
    } catch {
      // logging must not affect runtime behavior
    }
  };

  const onConnection = (ws, request) => {
    const bridge = attachWsConnection({
      syncServer,
      ws,
      keepAliveIntervalMs,
      logger,
    });
    bridges.set(bridge.connectionId, bridge);
    activeConnections += 1;
    log("connected", {
      connection_id: bridge.connectionId,
      active_connections: activeConnections,
      remote_address: request?.socket?.remoteAddress || null,
    });

    ws.on("close", () => {
      bridges.delete(bridge.connectionId);
      activeConnections = Math.max(0, activeConnections - 1);
      log("disconnected", {
        connection_id: bridge.connectionId,
        active_connections: activeConnections,
      });
    });
  };

  wsServer.on("connection", onConnection);

  return {
    getActiveConnections: () => activeConnections,
    closeAllConnections: async (reason = "server_close") => {
      const closing = [...bridges.values()].map((bridge) =>
        bridge.close(reason),
      );
      await Promise.allSettled(closing);
      bridges.clear();
      activeConnections = 0;
    },
    detach: () => {
      if (typeof wsServer.off === "function") {
        wsServer.off("connection", onConnection);
      }
    },
  };
};
