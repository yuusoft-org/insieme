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
});
