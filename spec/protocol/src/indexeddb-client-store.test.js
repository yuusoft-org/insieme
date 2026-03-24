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

const makeDraft = ({
  id = "evt-1",
  projectId,
  userId,
  partition = "P1",
  type = "x",
  schemaVersion = 1,
  payload = { n: 1 },
  clientId = "C1",
  clientTs = 100,
  metaExtras = {},
  createdAt = 100,
} = {}) => ({
  id,
  projectId,
  userId,
  partition,
  type,
  schemaVersion,
  payload,
  meta: { clientId, clientTs, ...metaExtras },
  createdAt,
});

const makeCommitted = ({
  id = "evt-1",
  partition = "P1",
  projectId = "proj-1",
  committedId = 1,
  type = "x",
  schemaVersion = 1,
  payload = { n: 1 },
  clientId = "C1",
  clientTs = 10,
  serverTs = 10,
} = {}) => ({
  id,
  partition,
  projectId,
  committedId,
  type,
  schemaVersion,
  payload,
  meta: { clientId, clientTs },
  serverTs,
});

const loadViews = async (store, viewName, partitions) =>
  Object.fromEntries(
    await Promise.all(
      partitions.map(async (partition) => [
        partition,
        await store.loadMaterializedView({ viewName, partition }),
      ]),
    ),
  );

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

      await store.insertDraft(
        makeDraft({
          projectId: "proj-1",
          userId: "u1",
          metaExtras: { source: "ui" },
        }),
      );
      await store.applySubmitResult({
        result: {
          id: "evt-1",
          status: "committed",
          committedId: 5,
          serverTs: 500,
        },
      });
      await store.applyCommittedBatch({ events: [], nextCursor: 5 });
      await store.applyCommittedBatch({ events: [], nextCursor: 2 });

      expect(await store.loadCursor()).toBe(5);
      const committed = await store._debug.getCommitted();
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        id: "evt-1",
        committedId: 5,
        meta: {
          clientTs: 100,
        },
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
        committedId: 5,
        meta: {
          clientTs: 100,
        },
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

    await store.insertDraft(
      makeDraft({
        id: "b",
        payload: { n: 1 },
      }),
    );
    await store.insertDraft(
      makeDraft({
        id: "a",
        payload: { n: 2 },
        createdAt: 101,
      }),
    );

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
      events: [makeCommitted()],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [makeCommitted({ committedId: 2, serverTs: 11 })],
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
      events: [makeCommitted()],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-2",
            payload: { n: 2 },
            serverTs: 11,
          }),
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
            count: state.count + (event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await store.init();

    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-1",
          type: "increment",
          payload: {},
        }),
        makeCommitted({
          id: "evt-2",
          committedId: 2,
          partition: "P1",
          type: "increment",
          payload: {},
          serverTs: 11,
        }),
        makeCommitted({
          id: "evt-3",
          committedId: 3,
          partition: "P2",
          type: "increment",
          payload: {},
          serverTs: 12,
        }),
      ],
      nextCursor: 3,
    });

    expect(await loadViews(store, "counter", ["P1", "P2"])).toEqual({
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
              count: state.count + (event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-1",
            type: "increment",
            payload: {},
          }),
        makeCommitted({
          id: "evt-2",
          committedId: 2,
          partition: "P1",
          type: "increment",
          payload: {},
          serverTs: 11,
        }),
        makeCommitted({
          id: "evt-3",
          committedId: 3,
          partition: "P2",
          type: "increment",
          payload: {},
          serverTs: 12,
        }),
      ],
      nextCursor: 3,
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
              count: state.count + (event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      expect(await loadViews(store, "counter", ["P1", "P2"])).toEqual({
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
            count: state.count + (event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await firstStore.init();

    const events = [];
    for (let index = 1; index <= 150; index += 1) {
      events.push(makeCommitted({
        id: `evt-${index}`,
        partition: index % 2 === 0 ? "P2" : "P1",
        committedId: index,
        type: "increment",
        payload: {},
        serverTs: index,
      }));
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
            count: state.count + (event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });
    await secondStore.init();

    expect(await loadViews(secondStore, "counter", ["P1", "P2"])).toEqual({
      P1: { count: 75 },
      P2: { count: 75 },
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

      await store.insertDraft(
        makeDraft({
          id: "b",
          payload: { n: 1 },
        }),
      );
      await store.insertDraft(
        makeDraft({
          id: "a",
          payload: { n: 2 },
          createdAt: 101,
        }),
      );

      expect((await store.loadDraftsOrdered()).map((draft) => draft.id)).toEqual([
        "b",
        "a",
      ]);

      await store.applyCommittedBatch({
        events: [makeCommitted()],
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
            count: state.count + (event.type === "increment" ? 1 : 0),
          }),
        },
      ],
      });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-1",
            type: "increment",
            payload: {},
          }),
        makeCommitted({
          id: "evt-2",
          committedId: 2,
          partition: "P1",
          type: "increment",
          payload: {},
          serverTs: 11,
        }),
        makeCommitted({
          id: "evt-3",
          committedId: 3,
          partition: "P2",
          type: "increment",
          payload: {},
          serverTs: 12,
        }),
      ],
      nextCursor: 3,
    });

      expect(
        await store.loadMaterializedView({
          viewName: "counter",
          partition: "P1",
        }),
      ).toEqual({ count: 2 });
      await store.flushMaterializedViews();
      expect(await store._debug.getCursor()).toBe(3);
      expect((await store._debug.getCommitted()).map((event) => event.id)).toEqual([
        "evt-1",
        "evt-2",
        "evt-3",
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
            count: state.count + (event.type === "increment" ? 1 : 0),
          }),
        },
      ],
      });
      await store.init();

      expect(await loadViews(store, "counter", ["P1", "P2"])).toEqual({
        P1: { count: 2 },
        P2: { count: 1 },
      });
    }
  });
});
