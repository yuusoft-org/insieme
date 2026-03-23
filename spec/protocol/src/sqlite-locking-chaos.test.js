import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSqliteClientStore,
  createSqliteSyncStore,
} from "../../../src/index.js";
import { createSqliteDb, hasNodeSqlite } from "./helpers/sqlite-db.js";

const tempDirs = [];

const createDbPath = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return path.join(dir, "store.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const expectSqliteBusy = async (operation) => {
  await expect(operation).rejects.toThrow(/locked|busy/i);
};

const describeSqlite = hasNodeSqlite ? describe : describe.skip;

describeSqlite("src sqlite locking chaos", () => {
  it("client store write fails with SQLITE_BUSY under concurrent writer lock, then recovers", async () => {
    const dbPath = createDbPath("insieme-chaos-client");
    const writerDb = createSqliteDb(dbPath);
    const lockerDb = createSqliteDb(dbPath);
    const store = createSqliteClientStore(writerDb, { busyTimeoutMs: 0 });

    await store.init();
    lockerDb.exec("PRAGMA busy_timeout=0;");
    lockerDb.exec("BEGIN IMMEDIATE;");

    await expectSqliteBusy(
      store.insertDraft({
        id: "evt-lock-1",
        partition: "P1",
        type: "x",
        schemaVersion: 1,
        payload: { n: 1 },
        meta: { clientId: "C1", clientTs: 100 },
        createdAt: 100,
      }),
    );

    lockerDb.exec("ROLLBACK;");
    await store.insertDraft({
      id: "evt-lock-1",
      partition: "P1",
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C1", clientTs: 100 },
      createdAt: 100,
    });

    const drafts = await store.loadDraftsOrdered();
    expect(drafts).toHaveLength(1);

    lockerDb.close();
    writerDb.close();
  });

  it("sync store commit fails with SQLITE_BUSY under concurrent writer lock, then recovers", async () => {
    const dbPath = createDbPath("insieme-chaos-sync");
    const writerDb = createSqliteDb(dbPath);
    const lockerDb = createSqliteDb(dbPath);
    const store = createSqliteSyncStore(writerDb, { busyTimeoutMs: 0 });

    await store.init();
    lockerDb.exec("PRAGMA busy_timeout=0;");
    lockerDb.exec("BEGIN IMMEDIATE;");

    await expectSqliteBusy(
      store.commitOrGetExisting({
        id: "evt-lock-2",
        partition: "P1",
        projectId: "proj-1",
        type: "x",
        schemaVersion: 1,
        payload: { n: 2 },
        meta: { clientId: "C1", clientTs: 200 },
        now: 200,
      }),
    );

    lockerDb.exec("ROLLBACK;");
    const committed = await store.commitOrGetExisting({
      id: "evt-lock-2",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: { n: 2 },
      meta: { clientId: "C1", clientTs: 200 },
      now: 200,
    });
    expect(committed).toMatchObject({
      deduped: false,
      committedEvent: {
        id: "evt-lock-2",
        committedId: 1,
      },
    });

    lockerDb.close();
    writerDb.close();
  });
});
