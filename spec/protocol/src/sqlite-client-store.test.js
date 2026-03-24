import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createSqliteClientStore,
  createSqliteStore,
} from "../../../src/index.js";
import { createSqliteDb, hasNodeSqlite } from "./helpers/sqlite-db.js";

const tempDirs = [];

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-client-store-"));
  tempDirs.push(dir);
  return path.join(dir, "client.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const describeSqlite = hasNodeSqlite ? describe : describe.skip;
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

describeSqlite("src createSqliteClientStore", () => {
  it("runs migrations and sets schema version", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db);

    await store.init();

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(5);
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
    const committedMeta = db._raw
      .prepare("SELECT type FROM pragma_table_info('committed_events') WHERE name = 'meta'")
      .get();
    expect(draftProject.type).toBe("TEXT");
    expect(draftUser.type).toBe("TEXT");
    expect(draftPayload.type).toBe("BLOB");
    expect(draftMeta.type).toBe("TEXT");
    expect(committedPayload.type).toBe("BLOB");
    expect(committedMeta.type).toBe("TEXT");

    db.close();
  });

  it("persists state across restart and keeps cursor monotonic", async () => {
    const dbPath = createDbPath();

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db);
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
          projectId: "proj-1",
          userId: "u1",
          meta: {
            clientId: "C1",
            clientTs: 100,
            source: "ui",
          },
        }),
      ]);
      db.close();
    }

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db);
      await store.init();

      expect(await store.loadCursor()).toBe(5);

      expect(await store._debug.getCommitted()).toEqual([
        expect.objectContaining({
          id: "evt-1",
          committedId: 5,
          projectId: "proj-1",
          userId: "u1",
          meta: {
            clientId: "C1",
            clientTs: 100,
            source: "ui",
          },
        }),
      ]);

      db.close();
    }
  });

  it("fails fast on older on-disk schema versions", async () => {
    const db = createSqliteDb(":memory:");
    db.exec(`
      PRAGMA user_version=4;
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
    const store = createSqliteClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Client store requires reset for schema version 4; runtime expects 5",
    );

    db.close();
  });

  it("rejects conflicting duplicate committed rows", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db);
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
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db);
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
    const db = createSqliteDb(":memory:");
    db.exec("PRAGMA user_version=999;");
    const store = createSqliteClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );

    db.close();
  });

  it("persists and backfills materialized views from committed events", async () => {
    const dbPath = createDbPath();

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db);
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
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, {
        materializedViews: [
          {
            name: "counter",
            version: "1",
            initialState: () => ({ count: 0 }),
            reduce: ({ state, event }) => ({
              count: state.count + (event.type === "increment" ? 1 : 0),
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

  it("supports deferred materialized-view checkpoints and explicit flush", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db, {
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
          makeCommitted({ type: "increment", payload: {}, serverTs: 10, clientTs: 10 }),
        ],
      nextCursor: 1,
    });

    expect(await loadViews(store, "counter", ["P1"])).toEqual({
      P1: { count: 1 },
    });

    const beforeFlush = db._raw
      .prepare("SELECT COUNT(*) AS count FROM materialized_view_state")
      .get();
    expect(beforeFlush.count).toBe(0);

    await store.flushMaterializedViews();

    const checkpoint = db._raw
      .prepare(
        `
          SELECT view_version, last_committed_id, value
          FROM materialized_view_state
          WHERE view_name = ? AND partition = ?
        `,
      )
      .get("counter", "P1");

    expect(checkpoint.view_version).toBe("1");
    expect(checkpoint.last_committed_id).toBe(1);
    expect(JSON.parse(checkpoint.value)).toEqual({ count: 1 });

    await store.invalidateMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      db._raw
        .prepare("SELECT COUNT(*) AS count FROM materialized_view_state")
        .get().count,
    ).toBe(0);

    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });

    db.close();
  });

  it("supports the alias export and explicit materialized-view eviction", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteStore(db, {
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
          makeCommitted({ type: "increment", payload: {}, serverTs: 10, clientTs: 10 }),
        ],
        nextCursor: 1,
      });

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

    db.close();
  });

  it("rebuilds exact materialized views after restart without a flushed checkpoint", async () => {
    const dbPath = createDbPath();

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, {
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
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, {
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

      db.close();
    }
  });

  it("preserves exact materialized views through repeated restarts with deferred checkpoints never flushed", async () => {
    const dbPath = createDbPath();

    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, {
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
            id: `evt-${cycle}`,
            committedId: cycle,
            type: "increment",
            payload: {},
            serverTs: cycle,
            clientTs: cycle,
          }),
        ],
        nextCursor: cycle,
      });

      expect(
        db._raw
          .prepare("SELECT COUNT(*) AS count FROM materialized_view_state")
          .get().count,
      ).toBe(0);

      db.close();
    }

    const finalDb = createSqliteDb(dbPath);
    const finalStore = createSqliteClientStore(finalDb, {
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
    await finalStore.init();

    expect(
      await finalStore.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 4 });

    finalDb.close();
  });
});
