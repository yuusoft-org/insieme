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

const createMockStore = () => {
  /** @type {object[]} */
  const drafts = [];
  /** @type {object[]} */
  const committed = [];
  let cursor = 0;

  const clone = (value) => structuredClone(value);
  const removeDraftById = (id) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };
  const upsertCommitted = (event) => {
    if (!event || typeof event !== "object") return;
    const index = committed.findIndex((entry) => entry.id === event.id);
    if (index >= 0) {
      committed[index] = clone(event);
      return;
    }
    committed.push(clone(event));
  };

  return {
    init: vi.fn(async () => {}),
    loadCursor: vi.fn(async () => cursor),
    insertDraft: vi.fn(async (item) => {
      drafts.push(clone(item));
    }),
    loadDraftsOrdered: vi.fn(async () => drafts.map(clone)),
    applySubmitResult: vi.fn(async ({ result }) => {
      if (result?.status === "committed") {
        const matchingDraft = drafts.find((draft) => draft.id === result.id);
        upsertCommitted({
          ...(matchingDraft ? clone(matchingDraft) : {}),
          id: result.id,
          committedId: result.committedId,
          created: result.created,
        });
        removeDraftById(result.id);
      } else if (result?.status === "rejected") {
        removeDraftById(result.id);
      }
    }),
    applyCommittedBatch: vi.fn(async ({ events, nextCursor }) => {
      for (const event of events || []) {
        upsertCommitted(event);
        removeDraftById(event.id);
      }
      if (typeof nextCursor === "number") {
        cursor = nextCursor;
      }
    }),
    _debug: {
      getDrafts: () => drafts.map(clone),
      getCommitted: () => committed.map(clone),
    },
  };
};

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

  it("serializes concurrent flush calls before loading drafts", async () => {
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

    store.loadDraftsOrdered.mockClear();
    await store.insertDraft({
      id: "evt-serial-1",
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C1", clientTs: 1000 },
      createdAt: 1000,
    });

    let releaseLoadDrafts;
    const loadDraftsGate = new Promise((resolve) => {
      releaseLoadDrafts = resolve;
    });
    store.loadDraftsOrdered.mockImplementation(async () => {
      await loadDraftsGate;
      return store._debug.getDrafts();
    });

    const firstFlush = client.flushDrafts();
    const secondFlush = client.flushDrafts();
    await tick();

    expect(store.loadDraftsOrdered).toHaveBeenCalledTimes(1);

    releaseLoadDrafts();
    await Promise.all([firstFlush, secondFlush]);

    const submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events.map((event) => event.id)).toEqual([
      "evt-serial-1",
    ]);
  });

  it("batches ordered drafts and sends the next batch only after the prior result", async () => {
    const client = await createStartedClient({
      transport,
      store,
      clientOverrides: {
        submitBatch: {
          maxEvents: 2,
        },
      },
    });

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

    const ids = await client.submitEvents([
      { id: "evt-b1", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 1 } },
      { id: "evt-b2", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 2 } },
      { id: "evt-b3", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 3 } },
    ]);

    expect(ids).toEqual(["evt-b1", "evt-b2", "evt-b3"]);

    let submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events.map((event) => event.id)).toEqual([
      "evt-b1",
      "evt-b2",
    ]);

    await client.flushDrafts();
    submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(1);

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          { id: "evt-b1", status: "committed", committedId: 10, created: 1110 },
          { id: "evt-b2", status: "committed", committedId: 11, created: 1111 },
        ],
      },
    });
    await tick();

    submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(2);
    expect(submits[1].payload.events.map((event) => event.id)).toEqual([
      "evt-b3",
    ]);
  });

  it("retries not_processed items in draft order after an earlier batch item fails", async () => {
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

    await client.submitEvents([
      { id: "evt-np-1", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 1 } },
      { id: "evt-np-2", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 2 } },
      { id: "evt-np-3", partitions: ["P1"], type: "x", schemaVersion: 1, payload: { n: 3 } },
    ]);

    let submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(1);
    expect(submits[0].payload.events.map((event) => event.id)).toEqual([
      "evt-np-1",
      "evt-np-2",
      "evt-np-3",
    ]);

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          {
            id: "evt-np-1",
            status: "rejected",
            reason: "validation_failed",
            created: 1111,
          },
          {
            id: "evt-np-2",
            status: "not_processed",
            reason: "prior_item_failed",
            blockedById: "evt-np-1",
            created: 1112,
          },
          {
            id: "evt-np-3",
            status: "not_processed",
            reason: "prior_item_failed",
            blockedById: "evt-np-1",
            created: 1113,
          },
        ],
      },
    });
    await tick();

    submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(2);
    expect(submits[1].payload.events.map((event) => event.id)).toEqual([
      "evt-np-2",
      "evt-np-3",
    ]);
    expect(store._debug.getDrafts().map((draft) => draft.id)).toEqual([
      "evt-np-2",
      "evt-np-3",
    ]);
  });

  it("rejects an oversized queued draft locally without sending it", async () => {
    const events = [];
    const client = await createStartedClient({
      transport,
      store,
      clientOverrides: {
        onEvent: (event) => events.push(event),
        submitBatch: {
          maxBytes: 80,
        },
      },
    });

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
      id: "evt-too-large-1",
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: { text: "x".repeat(512) },
      meta: { clientId: "C1", clientTs: 1000 },
      createdAt: 1000,
    });

    await client.flushDrafts();

    const submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(0);
    expect(store._debug.getDrafts()).toHaveLength(0);

    const errorEvent = events.find((entry) => entry.type === "error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.payload).toMatchObject({
      code: "submit_batch_too_large",
      details: expect.objectContaining({
        id: "evt-too-large-1",
        maxBytes: 80,
      }),
    });

    const rejectedEvent = events.find((entry) => entry.type === "rejected");
    expect(rejectedEvent).toBeTruthy();
    expect(rejectedEvent.payload).toMatchObject({
      id: "evt-too-large-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("keeps draft queued when submit send fails due disconnect", async () => {
    const events = [];
    const client = await createStartedClient({
      transport,
      store,
      clientOverrides: {
        onEvent: (event) => events.push(event),
      },
    });

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

    transport.send.mockImplementation(async (message) => {
      transport.sent.push(message);
      if (message.type === "submit_events") {
        throw new Error("websocket is not connected");
      }
    });

    await expect(
      client.submitEvent({
        partitions: ["P1"],
        type: "legacy.action",
        schemaVersion: 1,
        payload: { n: 1 },
      }),
    ).resolves.toBe("evt-local-1");

    expect(store.insertDraft).toHaveBeenCalledTimes(1);
    const errorEvent = events.find((entry) => entry.type === "error");
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.payload.code).toBe("transport_disconnected");
  });

  it("rolls back inserted drafts when fallback batch insert fails", async () => {
    const client = await createStartedClient({ transport, store });
    const originalInsertDraft = store.insertDraft;
    let insertCount = 0;

    store.insertDraft = vi.fn(async (item) => {
      insertCount += 1;
      if (insertCount === 2) {
        throw new Error("store write failed");
      }
      return originalInsertDraft(item);
    });

    await expect(
      client.submitEvents([
        {
          id: "evt-rollback-1",
          partitions: ["P1"],
          type: "x",
          schemaVersion: 1,
          payload: { n: 1 },
        },
        {
          id: "evt-rollback-2",
          partitions: ["P1"],
          type: "x",
          schemaVersion: 1,
          payload: { n: 2 },
        },
      ]),
    ).rejects.toThrow("store write failed");

    expect(store._debug.getDrafts()).toHaveLength(0);
    const submits = transport.sent.filter((message) => message.type === "submit_events");
    expect(submits).toHaveLength(0);
  });

  it("continues sync paging until hasMore is false", async () => {
    await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 5 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [{ id: "evt-1", committedId: 1 }],
        nextSinceCommittedId: 1,
        hasMore: true,
      },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [{ id: "evt-2", committedId: 2 }],
        nextSinceCommittedId: 2,
        hasMore: false,
      },
    });
    await tick();

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[1].payload.sinceCommittedId).toBe(1);
    expect(store.applyCommittedBatch).toHaveBeenNthCalledWith(2, {
      events: [{ id: "evt-2", committedId: 2 }],
      nextCursor: 2,
    });
  });

  it("queues local submits during active sync and flushes after sync completion", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 10 },
    });
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
    });

    let submits = transport.sent.filter(
      (message) => message.type === "submit_events",
    );
    expect(submits).toHaveLength(0);

    store.loadDraftsOrdered.mockResolvedValue([
      {
        id: "evt-local-1",
        partitions: ["P1"],
        type: "x",
        schemaVersion: 1,
        payload: { n: 1 },
        meta: { clientId: "C1", clientTs: 1000 },
        createdAt: 1000,
      },
    ]);

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 10,
        hasMore: false,
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

    store.loadCursor.mockResolvedValue(42);
    await client.setPartitions(["P2", "P3"], { sinceCommittedId: 42 });

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    const latestSync = syncCalls[syncCalls.length - 1];
    expect(latestSync.payload).toMatchObject({
      partitions: ["P2", "P3"],
      sinceCommittedId: 42,
      limit: 500,
    });
  });

  it("syncNow supports sinceCommittedId override for full partition catch-up [SC-12]", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 10 },
    });
    await tick();

    await client.syncNow({ sinceCommittedId: 0 });

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    const latestSync = syncCalls[syncCalls.length - 1];
    expect(latestSync.payload.sinceCommittedId).toBe(0);
  });

  it("uses durable cursor from store on startup sync", async () => {
    store.loadCursor.mockResolvedValue(77);
    await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 90 },
    });
    await tick();

    const syncCalls = transport.sent.filter(
      (message) => message.type === "sync",
    );
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].payload.sinceCommittedId).toBe(77);
  });

  it("recovers from sync send failure without locking draft flush", async () => {
    const client = await createStartedClient({ transport, store });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 1 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        nextSinceCommittedId: 1,
        hasMore: false,
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
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
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
        nextSinceCommittedId: 0,
        hasMore: false,
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
          payload: { clientId: "C1", globalLastCommittedId: 0 },
        });
      }
      if (message.type === "sync") {
        transport.emit({
          type: "sync_response",
          payload: {
            partitions: ["P1"],
            events: [],
            nextSinceCommittedId: 0,
            hasMore: false,
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

  it("adds outbound msgId and preserves inbound msgId in logs", async () => {
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
      msgId: "cli-msg-1",
    });

    transport.emit({
      type: "connected",
      msgId: "cli-msg-1",
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    expect(transport.sent[1]).toMatchObject({
      type: "sync",
      msgId: "cli-msg-2",
    });

    transport.emit({
      type: "sync_response",
      msgId: "cli-msg-2",
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
      payload: { n: 1 },
    });

    const submit = transport.sent.find(
      (message) => message.type === "submit_events",
    );
    expect(submit).toMatchObject({ msgId: "cli-msg-3" });

    transport.emit({
      type: "submit_events_result",
      msgId: "cli-msg-3",
      payload: {
        results: [
          {
            id: "evt-local-1",
            status: "committed",
            committedId: 1,
            created: 1001,
          },
        ],
      },
    });
    await tick();

    const connectedLog = logs.find((entry) => entry.event === "connected");
    expect(connectedLog.msgId).toBe("cli-msg-1");

    const committedLog = logs.find(
      (entry) => entry.event === "submit_committed",
    );
    expect(committedLog.msgId).toBe("cli-msg-3");
  });

  it("exposes runtime status via getStatus", async () => {
    const client = createSyncClient({
      transport,
      store,
      token: "jwt",
      clientId: "C1",
      partitions: ["P1"],
      now: () => 1000,
      uuid: () => "evt-local-1",
    });

    expect(client.getStatus()).toMatchObject({
      started: false,
      stopped: false,
      connected: false,
      syncInFlight: false,
      reconnectInFlight: false,
      reconnectAttempts: 0,
      activePartitions: ["P1"],
      lastError: null,
    });

    await client.start();
    expect(client.getStatus()).toMatchObject({
      started: true,
      stopped: false,
      connected: false,
      activePartitions: ["P1"],
    });

    transport.emit({
      type: "connected",
      payload: { clientId: "C1", globalLastCommittedId: 0 },
    });
    await tick();

    expect(client.getStatus()).toMatchObject({
      connected: true,
      lastError: null,
    });

    transport.emit({
      type: "error",
      payload: {
        code: "bad_request",
        message: "request malformed",
        details: {},
      },
    });
    await tick();

    expect(client.getStatus()).toMatchObject({
      connected: true,
      lastError: {
        code: "bad_request",
        message: "request malformed",
      },
    });

    await client.stop();
    expect(client.getStatus()).toMatchObject({
      started: false,
      stopped: true,
      connected: false,
    });
  });
});
