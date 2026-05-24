import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachWsConnection } from "../../../src/index.js";

class MockWsSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
    this.closed = [];
    this.pings = 0;
    this.terminated = false;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.emit("close");
  }

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
}

const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("src attachWsConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates required bridge inputs", () => {
    expect(() =>
      attachWsConnection({
        syncServer: null,
        ws: new MockWsSocket(),
      }),
    ).toThrow("syncServer.attachConnection is required");

    expect(() =>
      attachWsConnection({
        syncServer: { attachConnection: () => ({}) },
        ws: {},
      }),
    ).toThrow("ws socket is required");
  });

  it("forwards ws messages to session and session sends to ws", async () => {
    const ws = new MockWsSocket();
    const received = [];
    let attachedTransport = null;
    const closeReasons = [];

    const syncServer = {
      attachConnection: (transport) => {
        attachedTransport = transport;
        return {
          receive: async (message) => {
            received.push(message);
          },
          close: async (reason = "closed") => {
            closeReasons.push(reason);
          },
        };
      },
    };

    attachWsConnection({
      syncServer,
      ws,
      connectionId: "conn-1",
      keepAliveIntervalMs: 0,
    });

    ws.emit("message", Buffer.from(JSON.stringify({ type: "sync", payload: {} })));
    await waitForTick();

    expect(received).toEqual([{ type: "sync", payload: {} }]);

    await attachedTransport.send({
      type: "connected",
      payload: { clientId: "C1" },
    });
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: "connected",
      payload: { clientId: "C1" },
    });

    ws.readyState = 3;
    await attachedTransport.send({
      type: "event_broadcast",
      payload: { id: "evt-after-close" },
    });
    expect(ws.sent).toHaveLength(1);

    ws.emit("close");
    await waitForTick();
    expect(closeReasons).toContain("socket_closed");
  });

  it("closes ws with invalid_message on bad JSON payload", async () => {
    const ws = new MockWsSocket();
    const syncServer = {
      attachConnection: () => ({
        receive: async () => {},
        close: async () => {},
      }),
    };

    attachWsConnection({
      syncServer,
      ws,
      connectionId: "conn-2",
      keepAliveIntervalMs: 0,
    });

    ws.emit("message", "not-json");
    await waitForTick();

    expect(ws.closed[0]).toMatchObject({
      code: 1003,
      reason: "invalid_message",
    });
  });

  it("terminates sockets that miss keepalive pongs", async () => {
    vi.useFakeTimers();
    const ws = new MockWsSocket();
    const closeReasons = [];
    const syncServer = {
      attachConnection: () => ({
        receive: async () => {},
        close: async (reason) => {
          closeReasons.push(reason);
        },
      }),
    };

    attachWsConnection({
      syncServer,
      ws,
      connectionId: "conn-keepalive",
      keepAliveIntervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(ws.pings).toBe(1);
    expect(ws.isAlive).toBe(false);

    ws.emit("pong");
    expect(ws.isAlive).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(ws.pings).toBe(2);
    await vi.advanceTimersByTimeAsync(10);

    expect(ws.terminated).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(closeReasons).toContain("socket_closed");
  });

  it("returned close detaches listeners and is idempotent", async () => {
    const ws = new MockWsSocket();
    const closeReasons = [];
    const syncServer = {
      attachConnection: () => ({
        receive: async () => {},
        close: async (reason) => {
          closeReasons.push(reason);
        },
      }),
    };

    const bridge = attachWsConnection({
      syncServer,
      ws,
      connectionId: "conn-close",
      keepAliveIntervalMs: 0,
    });

    await bridge.close("manual_close");
    await bridge.close("second_close");
    ws.emit("message", JSON.stringify({ type: "sync", payload: {} }));
    await waitForTick();

    expect(closeReasons).toEqual(["manual_close"]);
  });
});
