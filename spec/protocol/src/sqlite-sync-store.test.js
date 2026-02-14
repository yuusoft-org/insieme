import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteSyncStore } from "../../../src/index.js";
import { createSqliteDb } from "./helpers/sqlite-db.js";

const tempDirs = [];

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-sync-store-"));
  tempDirs.push(dir);
  return path.join(dir, "sync.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("src createSqliteSyncStore", () => {
  it("runs migrations and dedupes with canonical equality", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    const first = await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P2", "P1"],
      event: { type: "event", payload: { schema: "x", data: { a: 1, b: 2 } } },
      now: 100,
    });

    const second = await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1", "P2"],
      event: { type: "event", payload: { data: { b: 2, a: 1 }, schema: "x" } },
      now: 101,
    });

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committed_id).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committed_id).toBe(1);

    const schema = db._raw.prepare("PRAGMA user_version").get();
    expect(schema.user_version).toBe(1);

    db.close();
  });

  it("supports crash-after-persist recovery with same id dedupe", async () => {
    const dbPath = createDbPath();

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteSyncStore(db);
      await store.init();

      const baseCommit = store.commitOrGetExisting;
      let crashed = false;
      const crashyCommit = async (input) => {
        const result = await baseCommit(input);
        if (!crashed) {
          crashed = true;
          throw new Error("crash-after-persist");
        }
        return result;
      };

      await expect(
        crashyCommit({
          id: "evt-crash",
          clientId: "C1",
          partitions: ["P1"],
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          now: 100,
        }),
      ).rejects.toThrow("crash-after-persist");

      db.close();
    }

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteSyncStore(db);
      await store.init();

      const retried = await store.commitOrGetExisting({
        id: "evt-crash",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
        now: 200,
      });

      expect(retried.deduped).toBe(true);
      expect(retried.committedEvent.committed_id).toBe(1);

      db.close();
    }
  });

  it("filters by partition and respects sync upper bound paging", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    await store.commitOrGetExisting({
      id: "evt-p1-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      now: 1,
    });
    await store.commitOrGetExisting({
      id: "evt-p2-1",
      clientId: "C1",
      partitions: ["P2"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      now: 2,
    });
    await store.commitOrGetExisting({
      id: "evt-p1-2",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      now: 3,
    });

    const first = await store.listCommittedSince({
      partitions: ["P1"],
      sinceCommittedId: 0,
      limit: 1,
      syncToCommittedId: 2,
    });

    expect(first.events.map((event) => event.id)).toEqual(["evt-p1-1"]);
    expect(first.hasMore).toBe(false);
    expect(first.nextSinceCommittedId).toBe(1);

    const second = await store.listCommittedSince({
      partitions: ["P1"],
      sinceCommittedId: 1,
      limit: 10,
      syncToCommittedId: 3,
    });

    expect(second.events.map((event) => event.id)).toEqual(["evt-p1-2"]);
    expect(second.nextSinceCommittedId).toBe(3);

    db.close();
  });

  it("fails fast on unsupported future schema version", async () => {
    const db = createSqliteDb(":memory:");
    db.exec("PRAGMA user_version=999;");
    const store = createSqliteSyncStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );

    db.close();
  });
});
