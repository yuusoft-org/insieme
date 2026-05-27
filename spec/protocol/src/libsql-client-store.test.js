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

const createFailingLibsqlClient = ({
  location = ":memory:",
  shouldFail = () => false,
  message = "forced libsql failure",
} = {}) => {
  const baseClient = createLibsqlClient(location);
  return {
    ...baseClient,
    async execute(statement) {
      const sql =
        typeof statement === "string" ? statement : String(statement?.sql || "");
      if (shouldFail(sql, statement)) {
        throw new Error(message);
      }
      return baseClient.execute(statement);
    },
  };
};

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

  it("supports concurrent init calls and optional pragmas", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlClientStore(db, {
      applyPragmas: true,
      busyTimeoutMs: 0,
    });

    await Promise.all([store.init(), store.init()]);

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(7);

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
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db);
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

  it("migrates legacy flat libSQL project stores without losing drafts or commits", async () => {
    const db = createLibsqlClient(":memory:");
    db._raw.exec(`
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

      PRAGMA user_version=6;
    `);
    db._raw
      .prepare(
        "INSERT INTO local_drafts(draft_clock, id, partition, type, schema_version, payload, client_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        3,
        "draft-routevn-1",
        "project:proj-1:story",
        "scene.rename",
        2,
        JSON.stringify({ sceneId: "s1", title: "Intro" }),
        101,
        102,
      );
    db._raw
      .prepare(
        "INSERT INTO committed_events(committed_id, id, project_id, user_id, partition, type, schema_version, payload, client_ts, server_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        7,
        "committed-routevn-1",
        "proj-1",
        "user-1",
        "project:proj-1:story",
        "scene.create",
        1,
        JSON.stringify({ sceneId: "s1" }),
        201,
        202,
        203,
      );
    db._raw
      .prepare("INSERT INTO app_state(key, value) VALUES (?, ?)")
      .run("cursor_committed_id", "7");

    const store = createLibsqlClientStore(db);
    await store.init();

    expect(db._raw.prepare("PRAGMA user_version").get().user_version).toBe(7);
    expect(await store.loadCursor()).toBe(7);
    expect(await store.loadDraftsOrdered()).toEqual([
      expect.objectContaining({
        draftClock: 3,
        id: "draft-routevn-1",
        partition: "project:proj-1:story",
        type: "scene.rename",
        schemaVersion: 2,
        payload: { sceneId: "s1", title: "Intro" },
      }),
    ]);
    expect(await store.listCommitted()).toEqual([
      expect.objectContaining({
        committedId: 7,
        id: "committed-routevn-1",
        partition: "project:proj-1:story",
        type: "scene.create",
        schemaVersion: 1,
        payload: { sceneId: "s1" },
        serverTs: 202,
      }),
    ]);

    await store.close();
  });

  it("fails fast on incompatible lower on-disk schema versions", async () => {
    const db = createLibsqlClient(":memory:");
    await db.execute("PRAGMA user_version=6;");
    const store = createLibsqlClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Client store requires reset for schema version 6; runtime expects 7",
    );

    db.close();
  });

  it("opens an existing compatible version 6 libSQL store", async () => {
    const db = createLibsqlClient(":memory:");
    db._raw.exec(`
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

    const store = createLibsqlClientStore(db);
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

  it("stores materialized-view checkpoint offsets per partition", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
        materializedViews: [createCounterView()],
      });
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
      await store.flushMaterializedViews();
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
      await store.flushMaterializedViews();
      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlClientStore(db, {
        materializedViews: [createCounterView()],
      });
      await store.init();

      expect(
        await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
      ).toEqual({ count: 2 });

      db.close();
    }
  });

  it("rebuilds legacy materialized checkpoints that lack per-partition offsets", async () => {
    const db = createLibsqlClient(":memory:");
    db._raw.exec(`
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
    db._raw
      .prepare(
        "INSERT INTO materialized_view_state(view_name, partition, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("counter", "P2", JSON.stringify({ count: 999 }), 999);
    db._raw
      .prepare(
        "INSERT INTO materialized_view_offsets(view_name, view_version, last_committed_id) VALUES (?, ?, ?)",
      )
      .run("counter", "1", 99);

    const store = createLibsqlClientStore(db, {
      materializedViews: [createCounterView()],
    });
    await store.init();

    expect(
      await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
    ).toEqual({ count: 2 });

    db.close();
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

  it("rolls back applySubmitResult when a later write fails", async () => {
    const db = createFailingLibsqlClient({
      shouldFail: (sql) => sql.includes("DELETE FROM local_drafts"),
      message: "delete draft failed",
    });
    const store = createLibsqlClientStore(db);
    await store.init();

    await store.insertDraft(makeDraft({ id: "evt-rollback-submit" }));

    await expect(
      store.applySubmitResult({
        result: {
          id: "evt-rollback-submit",
          status: "committed",
          committedId: 1,
          serverTs: 101,
        },
      }),
    ).rejects.toThrow("delete draft failed");

    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM committed_events").get().count,
    ).toBe(0);
    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM local_drafts").get().count,
    ).toBe(1);

    db.close();
  });

  it("rolls back applyCommittedBatch when cursor persistence fails", async () => {
    const db = createFailingLibsqlClient({
      shouldFail: (sql) =>
        sql.includes("INSERT INTO app_state(key, value)") &&
        sql.includes("ON CONFLICT(key) DO UPDATE"),
      message: "cursor save failed",
    });
    const store = createLibsqlClientStore(db);
    await store.init();

    await store.insertDraft(
      makeDraft({
        id: "evt-rollback-batch",
        createdAt: 100,
        clientTs: 100,
      }),
    );

    await expect(
      store.applyCommittedBatch({
        events: [
          makeCommitted({
            id: "evt-rollback-batch",
            committedId: 1,
            serverTs: 101,
            clientTs: 100,
          }),
        ],
        nextCursor: 1,
      }),
    ).rejects.toThrow("cursor save failed");

    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM committed_events").get().count,
    ).toBe(0);
    expect(
      db._raw.prepare("SELECT COUNT(*) AS count FROM local_drafts").get().count,
    ).toBe(1);
    expect(
      db._raw
        .prepare("SELECT value FROM app_state WHERE key = 'cursor_committed_id'")
        .get(),
    ).toBe(undefined);

    db.close();
  });
});
