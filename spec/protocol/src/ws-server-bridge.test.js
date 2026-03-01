import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachWsConnection } from "../../../src/index.js";

class MockWsSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
    this.closed = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.emit("close");
  }

  ping() {}
}

const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("src attachWsConnection", () => {
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
      payload: { client_id: "C1" },
    });
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: "connected",
      payload: { client_id: "C1" },
    });

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
});
