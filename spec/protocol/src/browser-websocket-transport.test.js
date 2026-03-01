import { describe, expect, it } from "vitest";
import { createBrowserWebSocketTransport } from "../../../src/index.js";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event, handler) {
    const set = this.listeners.get(event) || new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  removeEventListener(event, handler) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
  }

  emit(event, payload) {
    const handler =
      event === "open"
        ? this.onopen
        : event === "error"
          ? this.onerror
          : event === "message"
            ? this.onmessage
            : event === "close"
              ? this.onclose
              : null;
    if (typeof handler === "function") {
      handler(payload);
    }

    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "normal", wasClean: true });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  failConnect() {
    this.emit("error", { type: "error" });
  }

  emitMessage(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

const resetSockets = () => {
  MockWebSocket.instances.length = 0;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("src createBrowserWebSocketTransport", () => {
  it("connects, sends, and forwards parsed messages", async () => {
    resetSockets();
    const events = [];
    const transport = createBrowserWebSocketTransport({
      url: "ws://example.test/sync",
      WebSocketImpl: MockWebSocket,
    });
    transport.onMessage((message) => events.push(message));

    const connectPromise = transport.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connectPromise;

    await transport.send({
      type: "sync",
      payload: { since_committed_id: 0 },
    });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "sync",
    });

    socket.emitMessage({
      type: "connected",
      payload: { client_id: "C1" },
    });
    await tick();
    expect(events).toEqual([
      {
        type: "connected",
        payload: { client_id: "C1" },
      },
    ]);
  });

  it("throws if send is called while disconnected", async () => {
    resetSockets();
    const transport = createBrowserWebSocketTransport({
      url: "ws://example.test/sync",
      WebSocketImpl: MockWebSocket,
    });
    await expect(
      transport.send({ type: "sync", payload: {} }),
    ).rejects.toThrow("websocket is not connected");
  });

  it("rejects connect when websocket errors", async () => {
    resetSockets();
    const transport = createBrowserWebSocketTransport({
      url: "ws://example.test/sync",
      WebSocketImpl: MockWebSocket,
    });

    const connectPromise = transport.connect();
    const socket = MockWebSocket.instances[0];
    socket.failConnect();

    await expect(connectPromise).rejects.toThrow("websocket connect failed");
  });
});
