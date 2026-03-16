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

const createMockStore = () => {
  /** @type {object[]} */
  const drafts = [];
  let cursor = 0;
  const clone = (value) => structuredClone(value);
  const removeDraftById = (id) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  return {
    init: vi.fn(async () => {}),
    loadCursor: vi.fn(async () => cursor),
    insertDraft: vi.fn(async (item) => {
      drafts.push(clone(item));
    }),
    loadDraftsOrdered: vi.fn(async () => drafts.map(clone)),
    applySubmitResult: vi.fn(async ({ result }) => {
      if (result?.status === "committed" || result?.status === "rejected") {
        removeDraftById(result.id);
      }
    }),
    applyCommittedBatch: vi.fn(async ({ events, nextCursor }) => {
      for (const event of events || []) {
        removeDraftById(event.id);
      }
      if (typeof nextCursor === "number") {
        cursor = nextCursor;
      }
    }),
  };
};

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
      payload: { token: "jwt", clientId: "C1" },
    });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    expect(transport.sent[1]).toMatchObject({
      type: "sync",
      payload: { partitions: ["P1"], sinceCommittedId: 0, limit: 500 },
    });

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
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
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    const id = await client.submitEvent({
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: {},
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
            committedId: 10,
            created: 1111,
          },
        ],
      },
    });
    await tick();

    expect(store.applySubmitResult).toHaveBeenCalledWith({
      result: expect.objectContaining({
        id: "evt-local-1",
        status: "committed",
        committedId: 10,
      }),
    });
  });

  it("PT-SC-02: local submit rejected path", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: {},
    });

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          {
            id: "evt-local-1",
            status: "rejected",
            reason: "validation_failed",
            created: 1111,
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
    });
  });

  it("PT-SC-03: only one submit batch stays in flight at a time", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    await store.insertDraft({
      id: "evt-retry-1",
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: { a: 1 },
      meta: { clientId: "C1", clientTs: 1000 },
      createdAt: 1000,
    });

    await client.flushDrafts();

    const submits = transport.sent.filter((m) => m.type === "submit_events");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events[0].id).toBe("evt-retry-1");
  });
});
