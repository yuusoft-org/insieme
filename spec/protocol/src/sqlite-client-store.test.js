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
    expect(row.user_version).toBe(7);
    const draftClient = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'client_id'")
      .get();
    const draftPartitions = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'partitions'")
      .get();
    const draftEvent = db._raw
      .prepare("SELECT type FROM pragma_table_info('local_drafts') WHERE name = 'event'")
      .get();
    const committedStatus = db._raw
      .prepare(
        "SELECT type FROM pragma_table_info('committed_events') WHERE name = 'status_updated_at'",
      )
      .get();
    expect(draftClient.type).toBe("TEXT");
    expect(draftPartitions.type).toBe("TEXT");
    expect(draftEvent.type).toBe("TEXT");
    expect(committedStatus.type).toBe("INTEGER");

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
          committed_id: 5,
          client_id: "C1",
          partitions: ["P1", "proj-1"],
          status_updated_at: 500,
          event: {
            type: "event",
            payload: {
              schema: "x",
              schemaVersion: 1,
              data: { n: 1 },
            },
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
          committed_id: 5,
          client_id: "C1",
          partitions: ["P1", "proj-1"],
          status_updated_at: 500,
          event: {
            type: "event",
            payload: {
              schema: "x",
              schemaVersion: 1,
              data: { n: 1 },
            },
          },
        }),
      ]);

      db.close();
    }
  });

  it("opens an existing old-shape SQLite store without event-table migration", async () => {
    const db = createSqliteDb(":memory:");
    db.exec(`
      CREATE TABLE local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );

      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      PRAGMA user_version=1;
    `);
    db._raw
      .prepare(
        "INSERT INTO local_drafts(id, client_id, partitions, event, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "draft-old-1",
        "C1",
        JSON.stringify(["P1", "proj-1"]),
        JSON.stringify({
          type: "event",
          payload: { schema: "draft.x", schemaVersion: 1, data: { n: 1 } },
        }),
        101,
      );
    db._raw
      .prepare(
        "INSERT INTO committed_events(committed_id, id, client_id, partitions, event, status_updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        7,
        "committed-old-1",
        "C2",
        JSON.stringify(["P2", "proj-1"]),
        JSON.stringify({
          type: "event",
          payload: { schema: "committed.x", schemaVersion: 2, data: { n: 2 } },
        }),
        202,
      );
    db._raw
      .prepare("INSERT INTO app_state(key, value) VALUES (?, ?)")
      .run("cursor_committed_id", "7");

    const store = createSqliteClientStore(db);
    await store.init();

    expect(db._raw.prepare("PRAGMA user_version").get().user_version).toBe(7);
    expect(await store.loadCursor()).toBe(7);
    expect(await store.loadDraftsOrdered()).toEqual([
      expect.objectContaining({
        id: "draft-old-1",
        clientId: "C1",
        partitions: ["P1", "proj-1"],
        partition: "P1",
        type: "draft.x",
        schemaVersion: 1,
        payload: { n: 1 },
      }),
    ]);
    expect(await store.listCommitted()).toEqual([
      expect.objectContaining({
        committed_id: 7,
        id: "committed-old-1",
        client_id: "C2",
        partitions: ["P2", "proj-1"],
        partition: "P2",
        type: "committed.x",
        schemaVersion: 2,
        payload: { n: 2 },
        status_updated_at: 202,
      }),
    ]);

    db.close();
  });

  it("fails fast on incompatible lower on-disk schema versions", async () => {
    const db = createSqliteDb(":memory:");
    db.exec("PRAGMA user_version=6;");
    const store = createSqliteClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Client store schema is incompatible; reset required",
    );

    db.close();
  });

  it("opens an existing compatible version 6 SQLite store", async () => {
    const db = createSqliteDb(":memory:");
    db.exec(`
      CREATE TABLE local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );

      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      PRAGMA user_version=6;
    `);
    db._raw
      .prepare(
        "INSERT INTO committed_events(committed_id, id, client_id, partitions, event, status_updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        1,
        "evt-v6-1",
        "C1",
        JSON.stringify(["P1", "proj-1"]),
        JSON.stringify({
          type: "event",
          payload: { schema: "x", schemaVersion: 1, data: { n: 1 } },
        }),
        100,
      );

    const store = createSqliteClientStore(db);
    await store.init();

    expect(db._raw.prepare("PRAGMA user_version").get().user_version).toBe(7);
    expect(await store.listCommitted()).toEqual([
      expect.objectContaining({
        id: "evt-v6-1",
        partition: "P1",
        type: "x",
        payload: { n: 1 },
      }),
    ]);

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
          SELECT state.value, offsets.view_version, offsets.last_committed_id
          FROM materialized_view_state state
          JOIN materialized_view_offsets offsets
            ON offsets.view_name = state.view_name
          WHERE state.view_name = ? AND state.partition = ?
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

  it("stores materialized-view checkpoint offsets per partition", async () => {
    const dbPath = createDbPath();
    const materializedViews = [
      {
        name: "counter",
        checkpoint: { mode: "manual" },
        initialState: () => ({ count: 0 }),
        reduce: ({ state, event }) => ({
          count: state.count + (event.type === "increment" ? 1 : 0),
        }),
      },
    ];

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, { materializedViews });
      await store.init();

      await store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-p2-1",
            committedId: 1,
            partition: "P2",
            type: "increment",
            payload: {},
            serverTs: 10,
          }),
        ],
        nextCursor: 1,
      });
      expect(
        await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
      ).toEqual({ count: 1 });
      await store.flushMaterializedViews({ viewName: "counter", partition: "P2" });
      await store.evictMaterializedView({ viewName: "counter", partition: "P2" });

      await store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-p2-2",
            committedId: 2,
            partition: "P2",
            type: "increment",
            payload: {},
            serverTs: 11,
          }),
          makeCommitted({
            id: "evt-p1-1",
            committedId: 3,
            partition: "P1",
            type: "increment",
            payload: {},
            serverTs: 12,
          }),
        ],
        nextCursor: 3,
      });
      expect(
        await store.loadMaterializedView({ viewName: "counter", partition: "P1" }),
      ).toEqual({ count: 1 });
      await store.flushMaterializedViews({ viewName: "counter", partition: "P1" });
      db.close();
    }

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db, { materializedViews });
      await store.init();

      expect(
        await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
      ).toEqual({ count: 2 });

      db.close();
    }
  });

  it("rebuilds legacy materialized checkpoints that lack per-partition offsets", async () => {
    const db = createSqliteDb(":memory:");
    db.exec(`
      CREATE TABLE local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );

      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(view_name, partition)
      );

      CREATE TABLE materialized_view_offsets (
        view_name TEXT PRIMARY KEY,
        view_version TEXT NOT NULL,
        last_committed_id INTEGER NOT NULL
      );

      PRAGMA user_version=2;
    `);
    const insertCommitted = db._raw.prepare(
      "INSERT INTO committed_events(committed_id, id, client_id, partitions, event, status_updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertCommitted.run(
      1,
      "evt-p2-1",
      "C1",
      JSON.stringify(["P2", "proj-1"]),
      JSON.stringify({
        type: "event",
        payload: { schema: "increment", schemaVersion: 1, data: {} },
      }),
      10,
    );
    insertCommitted.run(
      2,
      "evt-p2-2",
      "C1",
      JSON.stringify(["P2", "proj-1"]),
      JSON.stringify({
        type: "event",
        payload: { schema: "increment", schemaVersion: 1, data: {} },
      }),
      11,
    );
    insertCommitted.run(
      3,
      "evt-p1-1",
      "C1",
      JSON.stringify(["P1", "proj-1"]),
      JSON.stringify({
        type: "event",
        payload: { schema: "increment", schemaVersion: 1, data: {} },
      }),
      12,
    );
    db._raw
      .prepare(
        "INSERT INTO materialized_view_state(view_name, partition, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("counter", "P2", JSON.stringify({ count: 999 }), 999);
    db._raw
      .prepare(
        "INSERT INTO materialized_view_offsets(view_name, view_version, last_committed_id) VALUES (?, ?, ?)",
      )
      .run("counter", "1", 3);

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

    expect(
      await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
    ).toEqual({ count: 2 });
    await store.flushMaterializedViews();

    const checkpoint = db._raw
      .prepare(
        "SELECT value, view_version, last_committed_id FROM materialized_view_state WHERE view_name = ? AND partition = ?",
      )
      .get("counter", "P2");
    expect(JSON.parse(checkpoint.value)).toEqual({ count: 2 });
    expect(checkpoint.view_version).toBe("1");
    expect(checkpoint.last_committed_id).toBe(2);

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
