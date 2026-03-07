import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWsServerRuntime } from "../../../src/index.js";

class MockWsSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
  }

  send() {}
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  ping() {}
}

const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("src createWsServerRuntime", () => {
  it("validates required ws server and sync server hooks", () => {
    expect(() => createWsServerRuntime({})).toThrow(
      "createWsServerRuntime: wsServer.on is required",
    );
    expect(() =>
      createWsServerRuntime({
        wsServer: new EventEmitter(),
        syncServer: {},
      }),
    ).toThrow("createWsServerRuntime: syncServer.attachConnection is required");
  });

  it("tracks active connections and can close all", async () => {
    const wsServer = new EventEmitter();
    const syncServer = {
      attachConnection: () => ({
        receive: async () => {},
        close: async () => {},
      }),
    };

    const runtime = createWsServerRuntime({
      wsServer,
      syncServer,
      keepAliveIntervalMs: 0,
    });

    const ws1 = new MockWsSocket();
    wsServer.emit("connection", ws1, { socket: { remoteAddress: "127.0.0.1" } });
    expect(runtime.getActiveConnections()).toBe(1);

    ws1.close();
    await waitForTick();
    expect(runtime.getActiveConnections()).toBe(0);

    const ws2 = new MockWsSocket();
    wsServer.emit("connection", ws2, { socket: { remoteAddress: "127.0.0.1" } });
    expect(runtime.getActiveConnections()).toBe(1);

    await runtime.closeAllConnections("shutdown");
    expect(runtime.getActiveConnections()).toBe(0);
  });

  it("detaches the connection listener and tolerates logger failures", async () => {
    const wsServer = new EventEmitter();
    wsServer.off = vi.fn(wsServer.off.bind(wsServer));
    const syncServer = {
      attachConnection: () => ({
        receive: async () => {},
        close: async () => {},
      }),
    };

    const runtime = createWsServerRuntime({
      wsServer,
      syncServer,
      logger: () => {
        throw new Error("logger failed");
      },
      keepAliveIntervalMs: 0,
    });

    const ws = new MockWsSocket();
    wsServer.emit("connection", ws, { socket: { remoteAddress: "127.0.0.1" } });
    expect(runtime.getActiveConnections()).toBe(1);

    runtime.detach();
    expect(wsServer.off).toHaveBeenCalledWith("connection", expect.any(Function));

    ws.close();
    await waitForTick();
    expect(runtime.getActiveConnections()).toBe(0);
  });
});
