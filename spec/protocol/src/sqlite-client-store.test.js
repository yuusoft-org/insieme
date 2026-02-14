import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteClientStore } from "../../../src/index.js";
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

describeSqlite("src createSqliteClientStore", () => {
  it("runs migrations and sets schema version", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db);

    await store.init();

    const row = db._raw.prepare("PRAGMA user_version").get();
    expect(row.user_version).toBe(1);

    db.close();
  });

  it("persists state across restart and keeps cursor monotonic", async () => {
    const dbPath = createDbPath();

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db);
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
      const db = createSqliteDb(dbPath);
      const store = createSqliteClientStore(db);
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
    const db = createSqliteDb(":memory:");
    const store = createSqliteClientStore(db);
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

  it("fails fast on unsupported future schema version", async () => {
    const db = createSqliteDb(":memory:");
    db.exec("PRAGMA user_version=999;");
    const store = createSqliteClientStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );

    db.close();
  });
});
