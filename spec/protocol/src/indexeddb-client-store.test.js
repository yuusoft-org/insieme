import { afterEach, describe, expect, it } from "vitest";
import { indexedDB } from "fake-indexeddb";
import { createIndexedDbClientStore } from "../../../src/index.js";

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
});
