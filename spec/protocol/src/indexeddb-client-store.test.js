import { afterEach, describe, expect, it } from "vitest";
import { IDBKeyRange, IDBObjectStore, indexedDB } from "fake-indexeddb";
import {
  createIndexedDbClientStore,
  createIndexedDBClientStore,
} from "../../../src/index.js";

const createDbName = () =>
  `insieme-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createdDbNames = [];

afterEach(async () => {
  for (const dbName of createdDbNames.splice(0)) {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
});

describe("src createIndexedDbClientStore", () => {
  it("rejects missing indexeddb implementations", () => {
    expect(() => createIndexedDbClientStore({ indexedDB: {} })).toThrow(
      "createIndexedDbClientStore requires a valid indexedDB implementation",
    );
  });

  it("persists cursor and committed events across restart", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);

    {
      const store = createIndexedDbClientStore({
        indexedDB,
        dbName,
      });
      await store.init();

      await store.insertDraft({
        id: "evt-1",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
        createdAt: 100,
      });
      await store.applySubmitResult({
        result: {
          id: "evt-1",
          status: "committed",
          committed_id: 5,
          status_updated_at: 500,
        },
        fallbackClientId: "C1",
      });
      await store.applyCommittedBatch({ events: [], nextCursor: 5 });
      await store.applyCommittedBatch({ events: [], nextCursor: 2 });

      expect(await store.loadCursor()).toBe(5);
      const committed = await store._debug.getCommitted();
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        id: "evt-1",
        committed_id: 5,
        client_id: "C1",
      });
    }

    {
      const store = createIndexedDbClientStore({
        indexedDB,
        dbName,
      });
      await store.init();
      expect(await store.loadCursor()).toBe(5);

      const committed = await store._debug.getCommitted();
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        id: "evt-1",
        committed_id: 5,
      });
    }
  });

  it("orders drafts by draftClock then id", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const store = createIndexedDbClientStore({
      indexedDB,
      dbName,
    });
    await store.init();

    await store.insertDraft({
      id: "b",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });
    await store.insertDraft({
      id: "a",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      createdAt: 101,
    });

    const drafts = await store.loadDraftsOrdered();
    expect(drafts.map((draft) => draft.id)).toEqual(["b", "a"]);
  });

  it("rejects conflicting duplicate committed rows", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const store = createIndexedDbClientStore({
      indexedDB,
      dbName,
    });
    await store.init();

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          status_updated_at: 10,
        },
      ],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [
          {
            id: "evt-1",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 2,
            event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
            status_updated_at: 11,
          },
        ],
      }),
    ).rejects.toThrow("committed event invariant violation");
  });

  it("rejects conflicting duplicate committed ids for different event ids", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const store = createIndexedDbClientStore({
      indexedDB,
      dbName,
    });
    await store.init();

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          status_updated_at: 10,
        },
      ],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [
          {
            id: "evt-2",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 1,
            event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
            status_updated_at: 11,
          },
        ],
      }),
    ).rejects.toThrow("committed event invariant violation");
  });

  it("supports materialized views with batch load, invalidate, and flush", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const store = createIndexedDbClientStore({
      indexedDB,
      dbName,
      materializedViews: [
        {
          name: "counter",
          checkpoint: { mode: "manual" },
          initialState: () => ({ count: 0 }),
          reduce: ({ state, event }) => ({
            count: state.count + (event.event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await store.init();

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "increment", payload: {} },
          status_updated_at: 10,
        },
        {
          id: "evt-2",
          client_id: "C1",
          partitions: ["P1", "P2"],
          committed_id: 2,
          event: { type: "increment", payload: {} },
          status_updated_at: 11,
        },
      ],
      nextCursor: 2,
    });

    expect(
      await store.loadMaterializedViews({
        viewName: "counter",
        partitions: ["P1", "P2"],
      }),
    ).toEqual({
      P1: { count: 2 },
      P2: { count: 1 },
    });

    await store.flushMaterializedViews();
    await store.invalidateMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });
  });

  it("rebuilds exact materialized views after restart without a flushed checkpoint", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);

    {
      const store = createIndexedDbClientStore({
        indexedDB,
        IDBKeyRange,
        dbName,
        materializedViews: [
          {
            name: "counter",
            checkpoint: { mode: "manual" },
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          {
            id: "evt-1",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 1,
            event: { type: "increment", payload: {} },
            status_updated_at: 10,
          },
          {
            id: "evt-2",
            client_id: "C1",
            partitions: ["P1", "P2"],
            committed_id: 2,
            event: { type: "increment", payload: {} },
            status_updated_at: 11,
          },
        ],
        nextCursor: 2,
      });
    }

    {
      const store = createIndexedDbClientStore({
        indexedDB,
        IDBKeyRange,
        dbName,
        materializedViews: [
          {
            name: "counter",
            checkpoint: { mode: "manual" },
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      expect(
        await store.loadMaterializedViews({
          viewName: "counter",
          partitions: ["P1", "P2"],
        }),
      ).toEqual({
        P1: { count: 2 },
        P2: { count: 1 },
      });
    }
  });

  it("replays larger indexeddb histories exactly with chunked materialized-view reads", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const firstStore = createIndexedDbClientStore({
      indexedDB,
      IDBKeyRange,
      dbName,
      materializedBackfillChunkSize: 7,
      materializedViews: [
        {
          name: "counter",
          checkpoint: { mode: "manual" },
          initialState: () => ({ count: 0 }),
          reduce: ({ state, event }) => ({
            count: state.count + (event.event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await firstStore.init();

    const events = [];
    for (let index = 1; index <= 150; index += 1) {
      events.push({
        id: `evt-${index}`,
        client_id: "C1",
        partitions: index % 3 === 0 ? ["P1", "P2"] : index % 2 === 0 ? ["P2"] : ["P1"],
        committed_id: index,
        event: { type: "increment", payload: {} },
        status_updated_at: index,
      });
    }

    await firstStore.applyCommittedBatch({
      events,
      nextCursor: 150,
    });

    const secondStore = createIndexedDbClientStore({
      indexedDB,
      IDBKeyRange,
      dbName,
      materializedBackfillChunkSize: 7,
      materializedViews: [
        {
          name: "counter",
          checkpoint: { mode: "manual" },
          initialState: () => ({ count: 0 }),
          reduce: ({ state, event }) => ({
            count: state.count + (event.event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await secondStore.init();

    expect(
      await secondStore.loadMaterializedViews({
        viewName: "counter",
        partitions: ["P1", "P2"],
      }),
    ).toEqual({
      P1: { count: 100 },
      P2: { count: 100 },
    });
  });

  it("falls back to cursor iteration when getAll is unavailable", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);
    const originalGetAll = IDBObjectStore.prototype.getAll;
    Object.defineProperty(IDBObjectStore.prototype, "getAll", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const store = createIndexedDbClientStore({
        indexedDB,
        dbName,
      });
      await store.init();

      await store.insertDraft({
        id: "b",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
        createdAt: 100,
      });
      await store.insertDraft({
        id: "a",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
        createdAt: 101,
      });

      expect((await store.loadDraftsOrdered()).map((draft) => draft.id)).toEqual([
        "b",
        "a",
      ]);

      await store.applyCommittedBatch({
        events: [
          {
            id: "evt-1",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 1,
            event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
            status_updated_at: 10,
          },
        ],
        nextCursor: 1,
      });

      expect((await store._debug.getCommitted()).map((event) => event.id)).toEqual([
        "evt-1",
      ]);
    } finally {
      Object.defineProperty(IDBObjectStore.prototype, "getAll", {
        value: originalGetAll,
        configurable: true,
        writable: true,
      });
    }
  });

  it("supports the alias export and catch-up without explicit IDBKeyRange injection", async () => {
    const dbName = createDbName();
    createdDbNames.push(dbName);

    {
      const store = createIndexedDBClientStore({
        indexedDB,
        dbName,
        materializedViews: [
          {
            name: "counter",
            checkpoint: { mode: "manual" },
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          {
            id: "evt-1",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 1,
            event: { type: "increment", payload: {} },
            status_updated_at: 10,
          },
          {
            id: "evt-2",
            client_id: "C1",
            partitions: ["P1", "P2"],
            committed_id: 2,
            event: { type: "increment", payload: {} },
            status_updated_at: 11,
          },
        ],
        nextCursor: 2,
      });

      expect(
        await store.loadMaterializedView({
          viewName: "counter",
          partition: "P1",
        }),
      ).toEqual({ count: 2 });
      await store.flushMaterializedViews();
      expect(await store._debug.getCursor()).toBe(2);
      expect((await store._debug.getCommitted()).map((event) => event.id)).toEqual([
        "evt-1",
        "evt-2",
      ]);

      await store.evictMaterializedView({
        viewName: "counter",
        partition: "P1",
      });
    }

    {
      const store = createIndexedDBClientStore({
        indexedDB,
        dbName,
        materializedViews: [
          {
            name: "counter",
            checkpoint: { mode: "manual" },
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      expect(
        await store.loadMaterializedViews({
          viewName: "counter",
          partitions: ["P1", "P2"],
        }),
      ).toEqual({
        P1: { count: 2 },
        P2: { count: 1 },
      });
    }
  });
});
