import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createLibsqlClientStore,
  createLibsqlStore,
} from "../../../src/index.js";
import { createLibsqlClient, hasNodeLibsqlShim } from "./helpers/libsql-db.js";

const tempDirs = [];

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-libsql-client-store-"));
  tempDirs.push(dir);
  return path.join(dir, "client.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const describeLibsql = hasNodeLibsqlShim ? describe : describe.skip;

describeLibsql("src createLibsqlClientStore", () => {
  it("runs migrations and sets schema version", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);

    await store.init();

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(3);

    db.close();
  });

  it("supports concurrent init calls and optional pragmas", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db, {
      applyPragmas: true,
      busyTimeoutMs: 0,
    });

    await Promise.all([store.init(), store.init()]);

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(3);

    db.close();
  });

  it("persists state across restart and keeps cursor monotonic", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
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
      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
      await store.init();

      expect(await store.loadCursor()).toBe(5);

      const committed = db._raw
        .prepare(
          "SELECT id, committed_id FROM committed_events ORDER BY committed_id",
        )
        .all();
      expect(committed).toEqual([
        {
          id: "evt-1",
          committed_id: 5,
        },
      ]);

      db.close();
    }
  });

  it("rejects conflicting duplicate committed rows", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
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
            committed_id: 9,
            event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
            status_updated_at: 11,
          },
        ],
      }),
    ).rejects.toThrow("committed event invariant violation");

    db.close();
  });

  it("rejects conflicting duplicate committed ids for different event ids", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
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

    db.close();
  });

  it("fails fast on unsupported future schema version", async () => {
    const db = createLibsqlClient(":memory:");
    await db.execute("PRAGMA user_version=999;");
    const store = createLibsqlClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );

    db.close();
  });

  it("persists and backfills materialized views from committed events", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
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

      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
        materializedViews: [
          {
            name: "counter",
            version: "1",
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.event.type === "increment" ? 1 : 0),
            }),
          },
        ],
      });
      await store.init();

      expect(
        await store.loadMaterializedView({
          viewName: "counter",
          partition: "P1",
        }),
      ).toEqual({ count: 2 });
      expect(
        await store.loadMaterializedView({
          viewName: "counter",
          partition: "P2",
        }),
      ).toEqual({ count: 1 });
      expect(
        await store.loadMaterializedView({
          viewName: "counter",
          partition: "P3",
        }),
      ).toEqual({ count: 0 });

      db.close();
    }
  });

  it("rebuilds exact materialized views after restart without a flushed checkpoint", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
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
        db._raw
          .prepare("SELECT COUNT(*) AS count FROM materialized_view_state")
          .get().count,
      ).toBe(0);

      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
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

      db.close();
    }
  });

  it("supports the alias export plus flush, invalidate, and eviction", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlStore(db, {
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
      ],
      nextCursor: 1,
    });

    await store.flushMaterializedViews();
    await store.evictMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });

    await store.invalidateMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });

    db.close();
  });

  it("handles rejected and missing-draft submit results without creating commits", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
    await store.init();

    await store.insertDraft({
      id: "evt-rejected",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });

    await store.applySubmitResult({
      result: {
        id: "evt-rejected",
        status: "rejected",
        status_updated_at: 101,
      },
      fallbackClientId: "C1",
    });

    await store.applySubmitResult({
      result: {
        id: "evt-missing",
        status: "committed",
        committed_id: 2,
        status_updated_at: 102,
      },
      fallbackClientId: "C1",
    });

    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM committed_events").get().count,
    ).toBe(0);

    db.close();
  });

  it("treats duplicate submit results idempotently and supports batches without cursor hints", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
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
        committed_id: 1,
        status_updated_at: 101,
      },
      fallbackClientId: "C1",
    });

    await store.insertDraft({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 102,
    });
    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committed_id: 1,
        status_updated_at: 103,
      },
      fallbackClientId: "C1",
    });

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-2",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 2,
          event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
          status_updated_at: 104,
        },
      ],
    });

    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM committed_events").get().count,
    ).toBe(2);

    db.close();
  });
});
