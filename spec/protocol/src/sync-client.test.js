import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient } from "../../../src/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createMockTransport = () => {
  /** @type {null|((message: object) => void)} */
  let onMessageHandler = null;
  /** @type {object[]} */
  const sent = [];

  return {
    sent,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (message) => {
      sent.push(message);
    }),
    onMessage: vi.fn((handler) => {
      onMessageHandler = handler;
      return () => {
        onMessageHandler = null;
      };
    }),
    emit(message) {
      if (onMessageHandler) onMessageHandler(message);
    },
  };
};

const createMockStore = () => ({
  init: vi.fn(async () => {}),
  loadCursor: vi.fn(async () => 0),
  insertDraft: vi.fn(async () => {}),
  loadDraftsOrdered: vi.fn(async () => []),
  applySubmitResult: vi.fn(async () => {}),
  applyCommittedBatch: vi.fn(async () => {}),
});

const createStartedClient = async ({
  transport,
  store,
  clientId = "C1",
  token = "jwt",
  partitions = ["P1"],
  clientOverrides = {},
} = {}) => {
  const client = createSyncClient({
    transport,
    store,
    token,
    clientId,
    partitions,
    now: () => 1000,
    uuid: () => "evt-local-1",
    ...clientOverrides,
  });

  await client.start();
  return client;
};

describe("src createSyncClient", () => {
  let transport;
  let store;

  beforeEach(() => {
    transport = createMockTransport();
    store = createMockStore();
  });

  it("PT-SC-00: handshake then empty sync page", async () => {
    await createStartedClient({ transport, store });

    expect(transport.sent[0]).toMatchObject({
      type: "connect",
      payload: { token: "jwt", client_id: "C1" },
    });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    expect(transport.sent[1]).toMatchObject({
      type: "sync",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: 500 },
    });

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    expect(store.applyCommittedBatch).toHaveBeenCalledWith({
      events: [],
      nextCursor: 0,
    });
  });

  it("PT-SC-01: local submit committed path", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    const id = await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: {} } },
    });

    expect(id).toBe("evt-local-1");
    expect(store.insertDraft).toHaveBeenCalledTimes(1);

    const submits = transport.sent.filter((m) => m.type === "submit_events");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events[0].id).toBe("evt-local-1");

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          {
            id: "evt-local-1",
            status: "committed",
            committed_id: 10,
            status_updated_at: 1111,
          },
        ],
      },
    });
    await tick();

    expect(store.applySubmitResult).toHaveBeenCalledWith({
      result: expect.objectContaining({
        id: "evt-local-1",
        status: "committed",
        committed_id: 10,
      }),
      fallbackClientId: "C1",
    });
  });

  it("PT-SC-02: local submit rejected path", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: {} } },
    });

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          {
            id: "evt-local-1",
            status: "rejected",
            reason: "validation_failed",
            status_updated_at: 1111,
          },
        ],
      },
    });
    await tick();

    expect(store.applySubmitResult).toHaveBeenCalledWith({
      result: expect.objectContaining({
        id: "evt-local-1",
        status: "rejected",
      }),
      fallbackClientId: "C1",
    });
  });

  it("PT-SC-03: duplicate retry reuses same draft id", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    store.loadDraftsOrdered.mockResolvedValue([
      {
        id: "evt-retry-1",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { a: 1 } } },
        createdAt: 1000,
      },
    ]);

    await client.flushDrafts();
    await client.flushDrafts();

    const submits = transport.sent.filter((m) => m.type === "submit_events");
    expect(submits).toHaveLength(2);
    expect(submits[0].payload.events[0].id).toBe("evt-retry-1");
    expect(submits[1].payload.events[0].id).toBe("evt-retry-1");
  });

  it("continues sync paging until has_more is false", async () => {
    await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 5 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [{ id: "evt-1", committed_id: 1 }],
        next_since_committed_id: 1,
        has_more: true,
      },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [{ id: "evt-2", committed_id: 2 }],
        next_since_committed_id: 2,
        has_more: false,
      },
    });
    await tick();

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[1].payload.since_committed_id).toBe(1);
    expect(store.applyCommittedBatch).toHaveBeenNthCalledWith(2, {
      events: [{ id: "evt-2", committed_id: 2 }],
      nextCursor: 2,
    });
  });

  it("queues local submits during active sync and flushes after sync completion", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 10 },
    });
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });

    let submits = transport.sent.filter(
      (message) => message.type === "submit_events",
    );
    expect(submits).toHaveLength(0);

    store.loadDraftsOrdered.mockResolvedValue([
      {
        id: "evt-local-1",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
        createdAt: 1000,
      },
    ]);

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 10,
        has_more: false,
      },
    });
    await tick();

    submits = transport.sent.filter(
      (message) => message.type === "submit_events",
    );
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events[0].id).toBe("evt-local-1");
  });

  it("disconnects on server_error", async () => {
    await createStartedClient({ transport, store });

    transport.emit({
      type: "error",
      payload: {
        code: "server_error",
        message: "Unexpected server error",
        details: {},
      },
    });
    await tick();

    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it("setPartitions triggers a new sync request", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    store.loadCursor.mockResolvedValue(42);
    await client.setPartitions(["P2", "P3"], { sinceCommittedId: 42 });

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    const latestSync = syncCalls[syncCalls.length - 1];
    expect(latestSync.payload).toMatchObject({
      partitions: ["P2", "P3"],
      since_committed_id: 42,
      limit: 500,
    });
  });

  it("syncNow supports sinceCommittedId override for full partition catch-up [SC-12]", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 10 },
    });
    await tick();

    await client.syncNow({ sinceCommittedId: 0 });

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    const latestSync = syncCalls[syncCalls.length - 1];
    expect(latestSync.payload.since_committed_id).toBe(0);
  });

  it("uses durable cursor from store on startup sync", async () => {
    store.loadCursor.mockResolvedValue(77);
    await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 90 },
    });
    await tick();

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].payload.since_committed_id).toBe(77);
  });

  it("recovers from sync send failure without locking draft flush", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 1 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 1,
        has_more: false,
      },
    });
    await tick();

    let failNextSync = true;
    transport.send.mockImplementation(async (message) => {
      transport.sent.push(message);
      if (message.type === "sync" && failNextSync) {
        failNextSync = false;
        throw new Error("network down");
      }
    });

    await expect(client.syncNow()).rejects.toThrow("network down");

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });

    const submitMessages = transport.sent.filter(
      (message) => message.type === "submit_events",
    );
    expect(submitMessages.length).toBeGreaterThan(0);
  });

  it("emits bad_server_message for invalid envelopes", async () => {
    const events = [];
    await createStartedClient({
      transport,
      store,
      clientOverrides: {
        onEvent: (event) => events.push(event),
      },
    });

    transport.emit({ foo: "bar" });
    await tick();

    const errorEvent = events.find((entry) => entry.type === "error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.payload.code).toBe("bad_server_message");
  });

  it("disconnects when message handler throws runtime error", async () => {
    const events = [];
    store.applyCommittedBatch.mockRejectedValueOnce(new Error("store failure"));

    await createStartedClient({
      transport,
      store,
      clientOverrides: {
        onEvent: (event) => events.push(event),
      },
    });

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    expect(transport.disconnect).toHaveBeenCalled();
    const error = events.find((entry) => entry.type === "error");
    expect(error).toBeTruthy();
    expect(error.payload.code).toBe("client_runtime_error");
  });

  it("reconnects with backoff policy after server_error", async () => {
    transport.send.mockImplementation(async (message) => {
      transport.sent.push(message);
      if (message.type === "connect") {
        transport.emit({
          type: "connected",
          payload: { client_id: "C1", server_last_committed_id: 0 },
        });
      }
      if (message.type === "sync") {
        transport.emit({
          type: "sync_response",
          payload: {
            partitions: ["P1"],
            events: [],
            next_since_committed_id: 0,
            has_more: false,
          },
        });
      }
    });

    await createStartedClient({
      transport,
      store,
      clientOverrides: {
        reconnect: {
          enabled: true,
          initialDelayMs: 0,
          maxDelayMs: 1,
          factor: 1,
          jitter: 0,
          handshakeTimeoutMs: 100,
        },
        sleep: async () => {},
      },
    });
    await tick();

    const connectsBefore = transport.connect.mock.calls.length;

    transport.emit({
      type: "error",
      payload: { code: "server_error", message: "boom", details: {} },
    });
    await tick();
    await tick();

    expect(transport.disconnect).toHaveBeenCalled();
    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectsBefore);
  });

  it("does not reconnect after auth_failed", async () => {
    await createStartedClient({
      transport,
      store,
      clientOverrides: {
        reconnect: {
          enabled: true,
          initialDelayMs: 0,
          maxDelayMs: 1,
          factor: 1,
          jitter: 0,
          handshakeTimeoutMs: 20,
        },
        sleep: async () => {},
      },
    });

    const connectsBefore = transport.connect.mock.calls.length;
    transport.emit({
      type: "error",
      payload: { code: "auth_failed", message: "auth failed", details: {} },
    });
    await tick();
    await tick();

    expect(transport.connect.mock.calls.length).toBe(connectsBefore);
  });

  it("adds outbound msg_id and preserves inbound msg_id in logs", async () => {
    const logs = [];
    let nextMsgId = 0;
    const client = await createStartedClient({
      transport,
      store,
      clientOverrides: {
        msgId: () => {
          nextMsgId += 1;
          return `cli-msg-${nextMsgId}`;
        },
        logger: (entry) => logs.push(entry),
      },
    });

    expect(transport.sent[0]).toMatchObject({
      type: "connect",
      msg_id: "cli-msg-1",
    });

    transport.emit({
      type: "connected",
      msg_id: "cli-msg-1",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });
    await tick();

    expect(transport.sent[1]).toMatchObject({
      type: "sync",
      msg_id: "cli-msg-2",
    });

    transport.emit({
      type: "sync_response",
      msg_id: "cli-msg-2",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });

    const submit = transport.sent.find(
      (message) => message.type === "submit_events",
    );
    expect(submit).toMatchObject({ msg_id: "cli-msg-3" });

    transport.emit({
      type: "submit_events_result",
      msg_id: "cli-msg-3",
      payload: {
        results: [
          {
            id: "evt-local-1",
            status: "committed",
            committed_id: 1,
            status_updated_at: 1001,
          },
        ],
      },
    });
    await tick();

    const connectedLog = logs.find((entry) => entry.event === "connected");
    expect(connectedLog.msg_id).toBe("cli-msg-1");

    const committedLog = logs.find(
      (entry) => entry.event === "submit_committed",
    );
    expect(committedLog.msg_id).toBe("cli-msg-3");
  });
});
