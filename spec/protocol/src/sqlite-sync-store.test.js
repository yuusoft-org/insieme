import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteSyncStore } from "../../../src/index.js";
import { createSqliteDb, hasNodeSqlite } from "./helpers/sqlite-db.js";

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

const describeSqlite = hasNodeSqlite ? describe : describe.skip;
const makeSubmit = (overrides = {}) => ({
  id: "evt-1",
  partition: "P1",
  projectId: "proj-1",
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

describeSqlite("src createSqliteSyncStore", () => {
  it("runs migrations and dedupes with canonical equality", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    const first = await store.commitOrGetExisting(
      makeSubmit({
        payload: { a: 1, b: 2 },
        now: 100,
      }),
    );

    const second = await store.commitOrGetExisting(
      makeSubmit({
        payload: { b: 2, a: 1 },
        now: 101,
      }),
    );

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committedId).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committedId).toBe(1);

    const schema = db._raw.prepare("PRAGMA user_version").get();
    expect(schema.user_version).toBe(5);
    const event = db._raw
      .prepare(
        "SELECT type FROM pragma_table_info('committed_events') WHERE name = 'event'",
      )
      .get();
    const canonical = db._raw
      .prepare(
        "SELECT type FROM pragma_table_info('committed_events') WHERE name = 'canonical'",
      )
      .get();
    const statusUpdatedAt = db._raw
      .prepare(
        "SELECT type FROM pragma_table_info('committed_events') WHERE name = 'status_updated_at'",
      )
      .get();
    expect(event.type).toBe("TEXT");
    expect(canonical.type).toBe("TEXT");
    expect(statusUpdatedAt.type).toBe("INTEGER");

    db.close();
  });

  it("preserves top-level clientId on stored commits", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    const result = await store.commitOrGetExisting(
      makeSubmit({
        clientId: "C-top",
        meta: undefined,
      }),
    );

    expect(result.committedEvent.client_id).toBe("C-top");

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
        crashyCommit(
          makeSubmit({
            id: "evt-crash",
            payload: { n: 1 },
            now: 100,
          }),
        ),
      ).rejects.toThrow("crash-after-persist");

      db.close();
    }

    {
      const db = createSqliteDb(dbPath);
      const store = createSqliteSyncStore(db);
      await store.init();

      const retried = await store.commitOrGetExisting(
        makeSubmit({
          id: "evt-crash",
          payload: { n: 1 },
          now: 200,
        }),
      );

      expect(retried.deduped).toBe(true);
      expect(retried.committedEvent.committedId).toBe(1);

      db.close();
    }
  });

  it("filters by project and respects sync upper bound paging", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-1", projectId: "proj-1", payload: { n: 1 }, now: 1 }),
    );
    await store.commitOrGetExisting(
      makeSubmit({
        id: "evt-p2-1",
        projectId: "proj-2",
        partition: "P2",
        payload: { n: 2 },
        now: 2,
      }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-2", projectId: "proj-1", payload: { n: 3 }, now: 3 }),
    );

    const first = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 1,
      syncToCommittedId: 2,
    });

    expect(first.events.map((event) => event.id)).toEqual(["evt-p1-1"]);
    expect(first.hasMore).toBe(false);
    expect(first.nextSinceCommittedId).toBe(1);

    const second = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 1,
      limit: 10,
      syncToCommittedId: 3,
    });

    expect(second.events.map((event) => event.id)).toEqual(["evt-p1-2"]);
    expect(second.nextSinceCommittedId).toBe(3);
    await expect(
      store.getMaxCommittedIdForProject({ projectId: "proj-1" }),
    ).resolves.toBe(3);
    await expect(
      store.getMaxCommittedIdForProject({ projectId: "proj-2" }),
    ).resolves.toBe(2);
    await expect(
      store.getMaxCommittedIdForProject({ projectId: "proj-9" }),
    ).resolves.toBe(0);

    db.close();
  });

  it("uses a global upper bound for direct multi-partition listing", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    await store.commitOrGetExisting(
      makeSubmit({
        id: "evt-a",
        projectId: "proj-1",
        partition: "A",
        payload: { n: 1 },
        now: 1,
      }),
    );
    await store.commitOrGetExisting(
      makeSubmit({
        id: "evt-b",
        projectId: "proj-1",
        partition: "B",
        payload: { n: 2 },
        now: 2,
      }),
    );

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      partitions: ["A", "B"],
      sinceCommittedId: 0,
      limit: 10,
    });

    expect(page.events.map((event) => event.id)).toEqual(["evt-a", "evt-b"]);

    db.close();
  });

  it("migrates a legacy flat RouteVN sync database without data loss", async () => {
    const db = createSqliteDb(":memory:");
    db.exec(`
      CREATE TABLE committed_events (
        committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        user_id TEXT,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        client_ts INTEGER NOT NULL,
        server_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db._raw
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
        "routevn-legacy-1",
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
    db.exec("PRAGMA user_version=4;");

    const store = createSqliteSyncStore(db);
    await store.init();

    expect(db._raw.prepare("PRAGMA user_version").get().user_version).toBe(5);
    expect(
      db._raw
        .prepare(
          "SELECT name FROM pragma_table_info('committed_events') WHERE name = 'project_id'",
        )
        .get(),
    ).toBeUndefined();

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });

    expect(page.events).toEqual([
      expect.objectContaining({
        committedId: 7,
        id: "routevn-legacy-1",
        partition: "project:proj-1:story",
        type: "scene.create",
        schemaVersion: 2,
        payload: { sceneId: "s1" },
        serverTs: 202,
      }),
    ]);

    db.close();
  });

  it("reads existing legacy rows with configured project metadata", async () => {
    const db = createSqliteDb(":memory:");
    const store = createSqliteSyncStore(db);
    await store.init();

    db._raw
      .prepare(
        `
          INSERT INTO committed_events(
            id,
            client_id,
            partitions,
            event,
            canonical,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "legacy-1",
        "C1",
        JSON.stringify(["proj-1", "P1"]),
        JSON.stringify({
          type: "event",
          payload: {
            schema: "x",
            schemaVersion: 1,
            data: { n: 1 },
          },
        }),
        "legacy-canonical",
        10,
      );

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });

    expect(page.events).toEqual([
      expect.objectContaining({
        id: "legacy-1",
        partition: "P1",
        type: "x",
        schemaVersion: 1,
        payload: { n: 1 },
        committedId: 1,
        serverTs: 10,
      }),
    ]);

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

  it("fails fast on incompatible future on-disk schema versions", async () => {
    const db = createSqliteDb(":memory:");
    db.exec("PRAGMA user_version=8;");
    const store = createSqliteSyncStore(db);

    await expect(store.init()).rejects.toThrow(
      "Unsupported schema version 8; runtime supports up to 5",
    );

    db.close();
  });
});
