import { describe, expect, it } from "vitest";
import { createOfflineTransport } from "../../../src/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("src createOfflineTransport", () => {
  it("responds locally to connect and sync while offline", async () => {
    const transport = createOfflineTransport({
      serverLastCommittedId: 11,
    });
    const received = [];
    transport.onMessage((message) => received.push(message));

    await transport.connect();
    await transport.send({
      type: "connect",
      protocol_version: "1.0",
      msg_id: "offline-connect-1",
      payload: { token: "jwt", client_id: "C1" },
    });
    await transport.send({
      type: "sync",
      protocol_version: "1.0",
      msg_id: "offline-sync-1",
      payload: { partitions: ["P1"], since_committed_id: 4 },
    });

    expect(received[0]).toMatchObject({
      type: "connected",
      msg_id: "offline-connect-1",
      payload: {
        client_id: "C1",
        server_last_committed_id: 11,
      },
    });
    expect(received[1]).toMatchObject({
      type: "sync_response",
      msg_id: "offline-sync-1",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 4,
        has_more: false,
      },
    });
  });

  it("replays buffered submits after switching to online transport", async () => {
    /** @type {null|((message: object) => void)} */
    let onlineOnMessage = null;
    const sent = [];
    const online = {
      connect: async () => {},
      disconnect: async () => {},
      send: async (message) => {
        sent.push(message);
        if (message.type === "connect" && onlineOnMessage) {
          onlineOnMessage({
            type: "connected",
            protocol_version: "1.0",
            payload: {
              client_id: message.payload.client_id,
              server_last_committed_id: 0,
            },
          });
        }
      },
      onMessage: (handler) => {
        onlineOnMessage = handler;
        return () => {
          if (onlineOnMessage === handler) onlineOnMessage = null;
        };
      },
    };

    const transport = createOfflineTransport();
    await transport.connect();
    await transport.send({
      type: "connect",
      protocol_version: "1.0",
      payload: { token: "jwt", client_id: "C1" },
    });
    await transport.send({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [{ id: "evt-1", partitions: ["P1"], event: { type: "event" } }],
      },
    });
    await transport.send({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [{ id: "evt-2", partitions: ["P1"], event: { type: "event" } }],
      },
    });

    await transport.setOnlineTransport(online);
    await tick();

    expect(sent[0].type).toBe("connect");
    expect(
      sent.slice(1).map((message) => message.payload.events[0].id),
    ).toEqual(["evt-1", "evt-2"]);
  });

  it("rejects invalid online transport shape and disconnected sends", async () => {
    const transport = createOfflineTransport();

    await expect(
      transport.send({ type: "connect", payload: {} }),
    ).rejects.toThrow("disconnected");
    await expect(transport.setOnlineTransport(null)).rejects.toThrow(
      "online transport must be an object",
    );
    await expect(transport.setOnlineTransport({})).rejects.toThrow(
      "online transport must implement connect/disconnect/send/onMessage",
    );
  });

  it("emits bad_request for invalid offline message and unknown message type", async () => {
    const transport = createOfflineTransport();
    const received = [];
    transport.onMessage((message) => received.push(message));
    await transport.connect();

    await transport.send("bad-message");
    await transport.send({
      type: "not_supported",
      protocol_version: "1.0",
      msg_id: "unknown-1",
      payload: {},
    });

    expect(received[0]).toMatchObject({
      type: "error",
      payload: {
        code: "bad_request",
        message: "Message must be an object with a string type",
      },
    });
    expect(received[1]).toMatchObject({
      type: "error",
      msg_id: "unknown-1",
      payload: {
        code: "bad_request",
      },
    });
  });

  it("enforces offline buffered submit capacity", async () => {
    const buffered = [];
    const received = [];
    const transport = createOfflineTransport({
      maxBufferedSubmits: 1,
      onBufferedSubmit: (entry) => buffered.push(entry),
    });
    transport.onMessage((message) => received.push(message));
    await transport.connect();

    await transport.send({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [
          { id: "evt-cap-1", partitions: ["P1"], event: { type: "event" } },
        ],
      },
    });
    await transport.send({
      type: "submit_events",
      protocol_version: "1.0",
      msg_id: "evt-cap-2",
      payload: {
        events: [
          { id: "evt-cap-2", partitions: ["P1"], event: { type: "event" } },
        ],
      },
    });

    expect(buffered).toEqual([{ id: "evt-cap-1", bufferedCount: 1 }]);
    expect(received[0]).toMatchObject({
      type: "error",
      msg_id: "evt-cap-2",
      payload: {
        code: "rate_limited",
      },
    });
  });

  it("supports online-first mode, transport replacement, and fallback to offline", async () => {
    const events = [];
    const makeOnline = (name) => {
      let handler = null;
      const sent = [];
      let connectCount = 0;
      let disconnectCount = 0;
      let unsubscribeCount = 0;
      return {
        name,
        sent,
        stats: {
          get connectCount() {
            return connectCount;
          },
          get disconnectCount() {
            return disconnectCount;
          },
          get unsubscribeCount() {
            return unsubscribeCount;
          },
        },
        transport: {
          connect: async () => {
            connectCount += 1;
          },
          disconnect: async () => {
            disconnectCount += 1;
          },
          send: async (message) => {
            sent.push(message);
            if (message.type === "connect" && handler) {
              handler({
                type: "connected",
                protocol_version: "1.0",
                payload: {
                  client_id: message.payload.client_id,
                  server_last_committed_id: 0,
                },
              });
            }
          },
          onMessage: (nextHandler) => {
            handler = nextHandler;
            return () => {
              unsubscribeCount += 1;
              if (handler === nextHandler) handler = null;
            };
          },
        },
      };
    };

    const onlineA = makeOnline("A");
    const onlineB = makeOnline("B");
    const transport = createOfflineTransport();
    transport.onMessage((message) => events.push(message));

    await transport.connect();
    expect(transport.getState()).toMatchObject({
      connected: true,
      online: false,
    });

    await transport.setOnlineTransport(onlineA.transport);
    expect(onlineA.stats.connectCount).toBe(1);
    expect(onlineA.sent).toEqual([]);

    await transport.send({
      type: "connect",
      protocol_version: "1.0",
      payload: { token: "jwt", client_id: "C1" },
    });
    expect(onlineA.sent[0].type).toBe("connect");

    // replace active online transport
    await transport.setOnlineTransport(onlineB.transport);
    expect(onlineA.stats.disconnectCount).toBe(1);
    expect(onlineA.stats.unsubscribeCount).toBeGreaterThan(0);
    expect(onlineB.stats.connectCount).toBe(1);
    expect(onlineB.sent[0].type).toBe("connect");

    // switching to offline disconnects current online transport
    await transport.setOffline();
    expect(onlineB.stats.disconnectCount).toBe(1);
    expect(transport.getState().online).toBe(false);

    const unsubscribe = transport.onMessage(() => {});
    unsubscribe();
    await transport.disconnect();
    expect(transport.getState().connected).toBe(false);
    expect(events.some((entry) => entry.type === "connected")).toBe(true);
  });
});
