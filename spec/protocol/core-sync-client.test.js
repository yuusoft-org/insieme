import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreSyncClient } from "../../examples/real-client-usage/common/createCoreSyncClient.js";

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
} = {}) => {
  const client = createCoreSyncClient({
    transport,
    store,
    token,
    clientId,
    partitions,
    now: () => 1000,
    uuid: () => "evt-local-1",
  });

  await client.start();
  return client;
};

describe("core sync client scenario mapping", () => {
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
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { a: 1 } } },
      },
    ]);

    await client.flushDrafts();
    await client.flushDrafts();

    const submits = transport.sent.filter((m) => m.type === "submit_events");
    expect(submits).toHaveLength(2);
    expect(submits[0].payload.events[0].id).toBe("evt-retry-1");
    expect(submits[1].payload.events[0].id).toBe("evt-retry-1");
  });
});
