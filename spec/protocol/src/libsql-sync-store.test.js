import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLibsqlSyncStore } from "../../../src/index.js";
import { createLibsqlClient, hasNodeLibsqlShim } from "./helpers/libsql-db.js";

const tempDirs = [];

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-libsql-sync-store-"));
  tempDirs.push(dir);
  return path.join(dir, "sync.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const describeLibsql = hasNodeLibsqlShim ? describe : describe.skip;
const makeSubmit = (overrides = {}) => ({
  id: "evt-1",
  partitions: ["P1"],
  type: "x",
  schemaVersion: 1,
  payload: { n: 1 },
  meta: {
    clientId: "C1",
    clientTs: 1,
  },
  now: 100,
  ...overrides,
});

describeLibsql("src createLibsqlSyncStore", () => {
  it("runs migrations and dedupes with canonical equality", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlSyncStore(db);
    await store.init();

    const first = await store.commitOrGetExisting(
      makeSubmit({
        partitions: ["P2", "P1"],
        payload: { a: 1, b: 2 },
        now: 100,
      }),
    );

    const second = await store.commitOrGetExisting(
      makeSubmit({
        partitions: ["P1", "P2"],
        payload: { b: 2, a: 1 },
        now: 101,
      }),
    );

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committedId).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committedId).toBe(1);

    const schema = db._raw.prepare("PRAGMA user_version").get();
    expect(schema.user_version).toBe(2);

    db.close();
  });

  it("supports crash-after-persist recovery with same id dedupe", async () => {
    const dbPath = createDbPath();

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlSyncStore(db);
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
        crashyCommit(
          makeSubmit({
            id: "evt-crash",
            partitions: ["P1"],
            payload: { n: 1 },
            now: 100,
          }),
        ),
      ).rejects.toThrow("crash-after-persist");

      db.close();
    }

    {
      const db = createLibsqlClient(dbPath);
      const store = createLibsqlSyncStore(db);
      await store.init();

      const retried = await store.commitOrGetExisting(
        makeSubmit({
          id: "evt-crash",
          partitions: ["P1"],
          payload: { n: 1 },
          now: 200,
        }),
      );

      expect(retried.deduped).toBe(true);
      expect(retried.committedEvent.committedId).toBe(1);

      db.close();
    }
  });

  it("filters by partition and respects sync upper bound paging", async () => {
    const db = createLibsqlClient(":memory:");
    const store = createLibsqlSyncStore(db);
    await store.init();

    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-1", partitions: ["P1"], payload: { n: 1 }, now: 1 }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p2-1", partitions: ["P2"], payload: { n: 2 }, now: 2 }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-2", partitions: ["P1"], payload: { n: 3 }, now: 3 }),
    );

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
    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P1"] }),
    ).resolves.toBe(3);
    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P2"] }),
    ).resolves.toBe(2);
    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P9"] }),
    ).resolves.toBe(0);

    db.close();
  });

  it("fails fast on unsupported future schema version", async () => {
    const db = createLibsqlClient(":memory:");
    await db.execute("PRAGMA user_version=999;");
    const store = createLibsqlSyncStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 999",
    );

    db.close();
  });
});
