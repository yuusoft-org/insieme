import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsyncSqliteClientStore } from "../../../src/async-sqlite-client-store.js";
import {
  createAsyncSqliteDriver,
  hasNodeSqlite,
} from "./helpers/sqlite-db.js";

const tempDirs = [];

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-async-sqlite-"));
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
  partition = "P1",
  type = "x",
  schemaVersion = 1,
  payload = { n: 1 },
  clientId = "C1",
  clientTs = 100,
  createdAt = 100,
} = {}) => ({
  id,
  partition,
  type,
  schemaVersion,
  payload,
  meta: { clientId, clientTs },
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

const counterView = {
  name: "counter",
  checkpoint: { mode: "manual" },
  initialState: () => ({ count: 0 }),
  reduce: ({ state, event }) => ({
    count: state.count + (event.type === "increment" ? 1 : 0),
  }),
};

describeSqlite("src createAsyncSqliteClientStore", () => {
  it("runs migrations and persists state across restart", async () => {
    const dbPath = createDbPath();

    {
      const driver = createAsyncSqliteDriver(dbPath);
      const store = createAsyncSqliteClientStore({ driver });
      await store.init();

      await store.insertDraft(makeDraft({ id: "evt-1" }));
      await store.applySubmitResult({
        result: {
          id: "evt-1",
          status: "committed",
          committedId: 5,
          serverTs: 500,
        },
      });
      await store.applyCommittedBatch({ events: [], nextCursor: 5 });
      await store.close();
    }

    {
      const driver = createAsyncSqliteDriver(dbPath);
      const store = createAsyncSqliteClientStore({ driver });
      await store.init();

      expect(await store.getCursor()).toBe(5);
      expect((await store.listCommitted()).map((event) => event.id)).toEqual([
        "evt-1",
      ]);

      await store.close();
    }
  });

  it("opens an existing compatible version 6 async SQLite store", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    driver._raw.exec(`
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
    driver._raw
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

    const store = createAsyncSqliteClientStore({ driver });
    await store.init();

    expect(driver._raw.prepare("PRAGMA user_version").get().user_version).toBe(7);
    expect(await store.listCommitted()).toEqual([
      expect.objectContaining({
        id: "evt-v6-1",
        partition: "P1",
        type: "x",
        payload: { n: 1 },
      }),
    ]);

    await store.close();
  });

  it("migrates a legacy flat version 6 async SQLite client database without data loss", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    driver._raw.exec(`
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
    driver._raw
      .prepare(
        `INSERT INTO local_drafts(
          draft_clock,
          id,
          partition,
          type,
          schema_version,
          payload,
          client_ts,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        3,
        "draft-v6-1",
        "project:proj-1:story",
        "scene.update",
        2,
        JSON.stringify({ sceneId: "s2" }),
        301,
        302,
      );
    driver._raw
      .prepare(
        `INSERT INTO committed_events(
          committed_id,
          id,
          project_id,
          user_id,
          partition,
          type,
          schema_version,
          payload,
          client_ts,
          server_ts,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        7,
        "committed-v6-1",
        "proj-1",
        "user-1",
        "project:proj-1:story",
        "scene.create",
        2,
        JSON.stringify({ sceneId: "s1" }),
        101,
        202,
        203,
      );

    const store = createAsyncSqliteClientStore({ driver });
    await store.init();

    expect(driver._raw.prepare("PRAGMA user_version").get().user_version).toBe(7);
    expect(
      driver._raw
        .prepare(
          "SELECT name FROM pragma_table_info('committed_events') WHERE name = 'project_id'",
        )
        .get(),
    ).toBeUndefined();

    const drafts = await store.listDraftsOrdered();
    expect(drafts[0]).toMatchObject({
      id: "draft-v6-1",
      partition: "project:proj-1:story",
      type: "scene.update",
      schemaVersion: 2,
      payload: { sceneId: "s2" },
    });

    const committed = await store.listCommitted();
    expect(committed[0].committedId).toBe(7);
    expect(committed[0].id).toBe("committed-v6-1");
    expect(committed[0].projectId).toBe("proj-1");
    expect(committed[0].userId).toBe("user-1");
    expect(committed[0].partition).toBe("project:proj-1:story");
    expect(committed[0].type).toBe("scene.create");
    expect(committed[0].schemaVersion).toBe(2);
    expect(committed[0].payload).toEqual({ sceneId: "s1" });
    expect(committed[0].serverTs).toBe(202);

    await store.close();
  });

  it("exposes subscriptions and stable inspection APIs", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    const store = createAsyncSqliteClientStore({
      driver,
      materializedViews: [counterView],
    });
    await store.init();

    const notifications = [];
    const unsubscribe = await store.subscribeMaterializedView({
      viewName: "counter",
      partition: "P1",
      onChange: (payload) => {
        notifications.push(payload);
      },
    });

    await store.insertDraft(makeDraft({ id: "evt-1" }));
    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-2",
          committedId: 2,
          type: "increment",
          payload: {},
        }),
      ],
      nextCursor: 2,
    });

    expect((await store.listDraftsOrdered()).map((draft) => draft.id)).toEqual([
      "evt-1",
    ]);
    expect((await store.listCommitted()).map((event) => event.id)).toEqual([
      "evt-2",
    ]);
    expect(
      (
        await store.listCommittedAfter({
          sinceCommittedId: 1,
        })
      ).map((event) => event.id),
    ).toEqual(["evt-2"]);
    expect(await store.getCursor()).toBe(2);
    expect(notifications).toEqual([
      {
        viewName: "counter",
        partition: "P1",
        value: { count: 0 },
        lastCommittedId: 0,
        updatedAt: 0,
      },
      {
        viewName: "counter",
        partition: "P1",
        value: { count: 1 },
        lastCommittedId: 2,
        updatedAt: 10,
      },
    ]);

    unsubscribe();
    await store.close();

    await expect(store.loadCursor()).rejects.toMatchObject({
      code: "client_store_closed",
    });
  });

  it("rolls back committed batch writes when a later statement fails", async () => {
    const baseDriver = createAsyncSqliteDriver(":memory:");
    const store = createAsyncSqliteClientStore({
      driver: {
        init: () => baseDriver.init(),
        close: () => baseDriver.close(),
        transaction: (mode, run) =>
          baseDriver.transaction(mode, async (tx) =>
            run({
              query: tx.query,
              execute: async (sql, args = []) => {
                if (sql.includes("INSERT INTO app_state")) {
                  throw new Error("cursor persistence failed");
                }
                return tx.execute(sql, args);
              },
            }),
          ),
      },
    });
    await store.init();

    await expect(
      store.applyCommittedBatch({
        events: [makeCommitted({ id: "evt-1", committedId: 1 })],
        nextCursor: 1,
      }),
    ).rejects.toThrow("cursor persistence failed");

    expect(await store.listCommitted()).toEqual([]);
    expect(await store.getCursor()).toBe(0);

    await store.close();
  });

  it("supports materialized view lifecycle helpers, batch drafts, and debug inspectors", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    const store = createAsyncSqliteClientStore({
      driver,
      materializedViews: [counterView],
    });
    await store.init();

    await store.insertDrafts([
      makeDraft({
        id: "evt-a",
        type: "increment",
        payload: {},
        clientTs: 1,
        createdAt: 1,
      }),
      makeDraft({
        id: "evt-b",
        type: "increment",
        payload: {},
        clientTs: 2,
        createdAt: 2,
      }),
      makeDraft({
        id: "evt-r",
        payload: { n: 3 },
        clientTs: 3,
        createdAt: 3,
      }),
    ]);

    expect((await store.loadDraftsOrdered()).map((draft) => draft.id)).toEqual([
      "evt-a",
      "evt-b",
      "evt-r",
    ]);

    await store.applySubmitResult({
      result: {
        id: "evt-r",
        status: "rejected",
        reason: "validation_failed",
      },
    });

    const events = [
      makeCommitted({
        id: "evt-1",
        committedId: 1,
        partition: "P1",
        type: "increment",
        payload: {},
        clientTs: 10,
        serverTs: 10,
      }),
      makeCommitted({
        id: "evt-2",
        committedId: 2,
        partition: "P1",
        type: "increment",
        payload: {},
        clientTs: 11,
        serverTs: 11,
      }),
      makeCommitted({
        id: "evt-3",
        committedId: 3,
        partition: "P2",
        type: "increment",
        payload: {},
        clientTs: 12,
        serverTs: 12,
      }),
    ];

    await store.applyCommittedBatch({
      events,
      nextCursor: 3,
    });
    await store.applyCommittedBatch({
      events,
      nextCursor: 2,
    });

    expect((await store.listDraftsOrdered()).map((draft) => draft.id)).toEqual([
      "evt-a",
      "evt-b",
    ]);
    expect((await store.listCommitted()).map((event) => event.id)).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
    expect(await store.loadCursor()).toBe(3);
    expect(await store.getCursor()).toBe(3);
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

    await store.flushMaterializedViews();

    expect((await store._debug.getDrafts()).map((draft) => draft.id)).toEqual([
      "evt-a",
      "evt-b",
    ]);
    expect((await store._debug.getCommitted()).map((event) => event.id)).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
    expect(await store._debug.getCursor()).toBe(3);

    await store.evictMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });

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

    await store.close();
  });

  it("stores materialized-view checkpoint offsets per partition", async () => {
    const dbPath = createDbPath();

    {
      const driver = createAsyncSqliteDriver(dbPath);
      const store = createAsyncSqliteClientStore({
        driver,
        materializedViews: [counterView],
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
      await store.close();
    }

    {
      const driver = createAsyncSqliteDriver(dbPath);
      const store = createAsyncSqliteClientStore({
        driver,
        materializedViews: [counterView],
      });
      await store.init();

      expect(
        await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
      ).toEqual({ count: 2 });

      await store.close();
    }
  });

  it("rebuilds legacy materialized checkpoints that lack per-partition offsets", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    driver._raw.exec(`
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
    const insertCommitted = driver._raw.prepare(
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
    driver._raw
      .prepare(
        "INSERT INTO materialized_view_state(view_name, partition, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("counter", "P2", JSON.stringify({ count: 999 }), 999);
    driver._raw
      .prepare(
        "INSERT INTO materialized_view_offsets(view_name, view_version, last_committed_id) VALUES (?, ?, ?)",
      )
      .run("counter", "1", 99);

    const store = createAsyncSqliteClientStore({
      driver,
      materializedViews: [counterView],
    });
    await store.init();

    expect(
      await store.loadMaterializedView({ viewName: "counter", partition: "P2" }),
    ).toEqual({ count: 2 });

    await store.close();
  });

  it("treats duplicate submit results idempotently and rejects conflicting duplicates", async () => {
    const driver = createAsyncSqliteDriver(":memory:");
    const store = createAsyncSqliteClientStore({ driver });
    await store.init();

    await store.insertDraft(
      makeDraft({
        id: "evt-1",
        payload: { n: 1 },
        clientTs: 5,
        createdAt: 5,
      }),
    );
    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committedId: 1,
        serverTs: 10,
      },
    });

    await store.insertDraft(
      makeDraft({
        id: "evt-1",
        payload: { n: 1 },
        clientTs: 5,
        createdAt: 6,
      }),
    );
    await expect(
      store.applySubmitResult({
        result: {
          id: "evt-1",
          status: "committed",
          committedId: 1,
          serverTs: 10,
        },
      }),
    ).resolves.toBeUndefined();

    await store.insertDraft(
      makeDraft({
        id: "evt-1",
        payload: { n: 2 },
        clientTs: 5,
        createdAt: 7,
      }),
    );
    await expect(
      store.applySubmitResult({
        result: {
          id: "evt-1",
          status: "committed",
          committedId: 1,
          serverTs: 10,
        },
      }),
    ).rejects.toThrow("committed event invariant violation");

    expect((await store.listCommitted()).map((event) => event.id)).toEqual([
      "evt-1",
    ]);
    await store.close();
  });

  it("waits for in-flight reads before closing and rejects new work during shutdown", async () => {
    const gate = createDeferred();
    const baseDriver = createAsyncSqliteDriver(":memory:");
    let blockRead = true;
    const store = createAsyncSqliteClientStore({
      driver: {
        init: () => baseDriver.init(),
        close: () => baseDriver.close(),
        transaction: (mode, run) =>
          baseDriver.transaction(mode, async (tx) =>
            run({
              query: async (sql, args = []) => {
                if (
                  blockRead &&
                  mode === "read" &&
                  sql.includes("FROM app_state")
                ) {
                  blockRead = false;
                  await gate.promise;
                }
                return tx.query(sql, args);
              },
              execute: tx.execute,
            }),
          ),
      },
    });
    await store.init();

    const pendingRead = store.loadCursor();
    await Promise.resolve();

    const closePromise = store.close();

    await expect(store.listCommitted()).rejects.toMatchObject({
      code: "client_store_closed",
    });

    gate.resolve();

    await expect(pendingRead).resolves.toBe(0);
    await closePromise;
  });

  it("applies configured pragmas during initialization", async () => {
    const statements = [];
    let userVersion = 0;
    const tableInfoByName = {
      local_drafts: [
        { name: "draft_clock", type: "INTEGER" },
        { name: "id", type: "TEXT" },
        { name: "client_id", type: "TEXT" },
        { name: "partitions", type: "TEXT" },
        { name: "event", type: "TEXT" },
        { name: "created_at", type: "INTEGER" },
      ],
      committed_events: [
        { name: "committed_id", type: "INTEGER" },
        { name: "id", type: "TEXT" },
        { name: "client_id", type: "TEXT" },
        { name: "partitions", type: "TEXT" },
        { name: "event", type: "TEXT" },
        { name: "status_updated_at", type: "INTEGER" },
      ],
    };
    const store = createAsyncSqliteClientStore({
      driver: {
        close: async () => {},
        transaction: async (mode, run) =>
          run({
            query: async (sql) => {
              const normalizedSql = sql.replace(/\s+/g, " ").trim();
              if (normalizedSql === "PRAGMA user_version") {
                return [{ user_version: userVersion }];
              }
              const tableInfoMatch = normalizedSql.match(/^PRAGMA table_info\((.+)\)$/);
              if (tableInfoMatch) {
                return tableInfoByName[tableInfoMatch[1]] ?? [];
              }
              return [];
            },
            execute: async (sql) => {
              const normalizedSql = sql.replace(/\s+/g, " ").trim();
              statements.push(normalizedSql);
              const userVersionMatch = normalizedSql.match(/^PRAGMA user_version=(\d+)$/);
              if (userVersionMatch) {
                userVersion = Number(userVersionMatch[1]);
              }
              return { rowsAffected: 0 };
            },
          }),
      },
      applyPragmas: true,
      journalMode: "DELETE",
      synchronous: "NORMAL",
      busyTimeoutMs: 123,
    });

    await store.init();

    expect(statements).toEqual(
      expect.arrayContaining([
        "PRAGMA journal_mode=DELETE",
        "PRAGMA synchronous=NORMAL",
        "PRAGMA busy_timeout=123",
      ]),
    );

    await store.close();
  });

  it("validates drivers and rejects incompatible schema versions", async () => {
    expect(() => createAsyncSqliteClientStore()).toThrow(
      "createAsyncSqliteClientStore requires a driver with transaction(mode, run)",
    );

    const invalidTransactionStore = createAsyncSqliteClientStore({
      driver: {
        transaction: async (mode, run) =>
          run({
            query: async () => [],
          }),
      },
    });
    await expect(invalidTransactionStore.init()).rejects.toThrow(
      "async sqlite driver transaction requires query(sql, args?) and execute(sql, args?)",
    );

    const invalidQueryStore = createAsyncSqliteClientStore({
      driver: {
        transaction: async (mode, run) =>
          run({
            query: async () => "not-an-array",
            execute: async () => ({ rowsAffected: 0 }),
          }),
      },
    });
    await expect(invalidQueryStore.init()).rejects.toThrow(
      "async sqlite driver query must return an array of rows",
    );

    const futureDbPath = createDbPath();
    const futureSeedDriver = createAsyncSqliteDriver(futureDbPath);
    await futureSeedDriver.init();
    await futureSeedDriver.transaction("write", async (tx) => {
      await tx.execute("PRAGMA user_version=999");
    });
    await futureSeedDriver.close();

    const futureStore = createAsyncSqliteClientStore({
      driver: createAsyncSqliteDriver(futureDbPath),
    });
    await expect(futureStore.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );
    await futureStore.close();

    const legacyDbPath = createDbPath();
    const legacySeedDriver = createAsyncSqliteDriver(legacyDbPath);
    await legacySeedDriver.init();
    await legacySeedDriver.transaction("write", async (tx) => {
      await tx.execute("PRAGMA user_version=1");
    });
    await legacySeedDriver.close();

    const legacyStore = createAsyncSqliteClientStore({
      driver: createAsyncSqliteDriver(legacyDbPath),
    });
    await expect(legacyStore.init()).rejects.toThrow(
      "Client store schema is incompatible; reset required",
    );
    await legacyStore.close();
  });
});
