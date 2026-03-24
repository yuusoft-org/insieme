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

const createCounterView = () => ({
  name: "counter",
  checkpoint: { mode: "manual" },
  initialState: () => ({ count: 0 }),
  reduce: ({ state, event }) => ({
    count: state.count + (event.type === "increment" ? 1 : 0),
  }),
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

describeLibsql("src createLibsqlClientStore", () => {
  it("runs migrations and sets schema version", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);

    await store.init();

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(6);
    const draftProject = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'project_id'")
      .get();
    const draftUser = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'user_id'")
      .get();
    const draftPayload = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'payload'")
      .get();
    const draftMeta = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'meta'")
      .get();
    const committedPayload = db._raw
      .prepare(
        "SELECT type FROM pragma_table_info('committed_events') WHERE name = 'payload'",
      )
      .get();
    expect(draftProject).toBe(undefined);
    expect(draftUser).toBe(undefined);
    expect(draftPayload.type).toBe("BLOB");
    expect(draftMeta).toBe(undefined);
    expect(committedPayload.type).toBe("BLOB");
    expect(
      db._raw
        .prepare("SELECT type FROM pragma_table_info('committed_events') WHERE name = 'meta'")
        .get(),
    ).toBe(undefined);

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
    expect(row.user_version).toBe(6);

    db.close();
  });

  it("persists state across restart and keeps cursor monotonic", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
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
      expect(await store._debug.getCommitted()).toEqual([
        expect.objectContaining({
          id: "evt-1",
          committedId: 5,
          clientTs: 100,
        }),
      ]);
      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
      await store.init();

      expect(await store.loadCursor()).toBe(5);

      expect(await store._debug.getCommitted()).toEqual([
        expect.objectContaining({
          id: "evt-1",
          committedId: 5,
          clientTs: 100,
        }),
      ]);

      db.close();
    }
  });

  it("fails fast on older on-disk schema versions", async () => {
    const db = createLibsqlClient(":memory:");
    await db.execute(`
      PRAGMA user_version=5;
      CREATE TABLE local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        client_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT,
        user_id TEXT,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        client_ts INTEGER NOT NULL,
        server_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        view_version TEXT NOT NULL,
        last_committed_id INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(view_name, partition)
      );
    `);
    const store = createLibsqlClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Client store requires reset for schema version 5; runtime expects 6",
    );

    db.close();
  });

  it("rejects conflicting duplicate committed rows", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
    await store.init();

    await store.applyCommittedBatch({
      events: [makeCommitted()],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [makeCommitted({ committedId: 9, serverTs: 11, clientTs: 11 })],
      }),
    ).rejects.toThrow("committed event invariant violation");

    db.close();
  });

  it("rejects conflicting duplicate committed ids for different event ids", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db);
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
            clientTs: 11,
          }),
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
          makeCommitted({ type: "increment", payload: {}, serverTs: 10, clientTs: 10 }),
          makeCommitted({
            id: "evt-2",
            committedId: 2,
            partition: "P1",
            type: "increment",
            payload: {},
            serverTs: 11,
            clientTs: 11,
          }),
          makeCommitted({
            id: "evt-3",
            committedId: 3,
            partition: "P2",
            type: "increment",
            payload: {},
            serverTs: 12,
            clientTs: 12,
          }),
        ],
        nextCursor: 3,
      });

      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
        materializedViews: [
          {
            ...createCounterView(),
            version: "1",
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
        materializedViews: [createCounterView()],
      });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          makeCommitted({ type: "increment", payload: {}, serverTs: 10, clientTs: 10 }),
          makeCommitted({
            id: "evt-2",
            committedId: 2,
            partition: "P1",
            type: "increment",
            payload: {},
            serverTs: 11,
            clientTs: 11,
          }),
          makeCommitted({
            id: "evt-3",
            committedId: 3,
            partition: "P2",
            type: "increment",
            payload: {},
            serverTs: 12,
            clientTs: 12,
          }),
        ],
        nextCursor: 3,
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
        materializedViews: [createCounterView()],
      });
      await store.init();

      expect(await loadViews(store, "counter", ["P1", "P2"])).toEqual({
        P1: { count: 2 },
        P2: { count: 1 },
      });

      db.close();
    }
  });

  it("supports the alias export plus flush, invalidate, and eviction", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlStore(db, {
      materializedViews: [createCounterView()],
    });
    await store.init();

    await store.applyCommittedBatch({
      events: [makeCommitted({ type: "increment", payload: {}, serverTs: 10, clientTs: 10 })],
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

    await store.insertDraft(makeDraft({ id: "evt-rejected" }));

    await store.applySubmitResult({
      result: {
        id: "evt-rejected",
        status: "rejected",
        created: 101,
      },
    });

    await store.applySubmitResult({
      result: {
        id: "evt-missing",
        status: "committed",
        committedId: 2,
        serverTs: 102,
      },
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

    await store.insertDraft(makeDraft({ id: "evt-1", createdAt: 100, clientTs: 100 }));
    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committedId: 1,
        serverTs: 101,
      },
    });

    await store.insertDraft(makeDraft({ id: "evt-1", createdAt: 102, clientTs: 100 }));
    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committedId: 1,
        serverTs: 103,
      },
    });

    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-2",
          committedId: 2,
          payload: { n: 2 },
          serverTs: 104,
          clientTs: 104,
        }),
      ],
    });

    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM committed_events").get().count,
    ).toBe(2);

    db.close();
  });
});
