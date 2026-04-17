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
        { name: "partition", type: "TEXT" },
        { name: "type", type: "TEXT" },
        { name: "schema_version", type: "INTEGER" },
        { name: "payload", type: "BLOB" },
        { name: "payload_compression", type: "TEXT" },
        { name: "client_ts", type: "INTEGER" },
        { name: "created_at", type: "INTEGER" },
      ],
      committed_events: [
        { name: "committed_id", type: "INTEGER" },
        { name: "id", type: "TEXT" },
        { name: "project_id", type: "TEXT" },
        { name: "user_id", type: "TEXT" },
        { name: "partition", type: "TEXT" },
        { name: "type", type: "TEXT" },
        { name: "schema_version", type: "INTEGER" },
        { name: "payload", type: "BLOB" },
        { name: "payload_compression", type: "TEXT" },
        { name: "client_ts", type: "INTEGER" },
        { name: "server_ts", type: "INTEGER" },
        { name: "created_at", type: "INTEGER" },
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
      "Client store requires reset for schema version 1",
    );
    await legacyStore.close();
  });
});
