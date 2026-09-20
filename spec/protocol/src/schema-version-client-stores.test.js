import { describe, expect, test } from "vitest";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { createSqliteClientStore } from "../../../src/sqlite-client-store.js";
import { createLibsqlClientStore } from "../../../src/libsql-client-store.js";
import { createAsyncSqliteClientStore } from "../../../src/async-sqlite-client-store.js";
import { createIndexedDbClientStore } from "../../../src/indexeddb-client-store.js";
import {
  createSqliteDb,
  createAsyncSqliteDriver,
  hasNodeSqlite,
} from "./helpers/sqlite-db.js";
import { createLibsqlClient } from "./helpers/libsql-db.js";

const draft = (id, schemaVersion = 2) => ({
  id,
  partition: "main",
  type: "change",
  schemaVersion,
  payload: { mv: 16, commandPayload: { name: "Project One" } },
  clientTs: 123,
  createdAt: 456,
});
const request = (value) =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const sqlFixture = (adapter, driverVersion) => {
  const db =
    adapter === "sqlite"
      ? createSqliteDb()
      : adapter === "libsql"
        ? createLibsqlClient()
        : createAsyncSqliteDriver();
  const shared = { ...db, close: () => {} };
  if (driverVersion) {
    const convert = (row) =>
      row && Object.hasOwn(row, "schema_version")
        ? { ...row, schema_version: driverVersion(row.schema_version) }
        : row;
    if (adapter === "sqlite")
      shared.prepare = (sql) => {
        const stmt = db.prepare(sql);
        return {
          ...stmt,
          get: (params) => convert(stmt.get(params)),
          all: (params) => stmt.all(params).map(convert),
        };
      };
    if (adapter === "libsql")
      shared.execute = async (statement) => {
        const result = await db.execute(statement);
        return { ...result, rows: result.rows.map(convert) };
      };
    if (adapter === "async-sqlite")
      shared.transaction = (mode, run) =>
        db.transaction(mode, (tx) =>
          run({
            ...tx,
            query: async (sql, args) =>
              (await tx.query(sql, args)).map(convert),
          }),
        );
  }
  const create = (options = {}) =>
    adapter === "sqlite"
      ? createSqliteClientStore(shared, options)
      : adapter === "libsql"
        ? createLibsqlClientStore(shared, options)
        : createAsyncSqliteClientStore({
            driver: shared,
            ...options,
          });
  return {
    create,
    patch: async (table, id, version) =>
      db._raw
        .prepare(
          `UPDATE ${table === "drafts" ? "local_drafts" : "committed_events"} SET schema_version = ? WHERE id = ?`,
        )
        .run(version, id),
    rawCommitted: async (id) =>
      db._raw
        .prepare("SELECT schema_version FROM committed_events WHERE id = ?")
        .get(id).schema_version,
    close: () => db.close(),
  };
};
const browserFixture = async () => {
  const dbName = `schema-versions-${crypto.randomUUID()}`;
  const create = (options = {}) =>
    createIndexedDbClientStore({
      indexedDB,
      IDBKeyRange,
      dbName,
      ...options,
    });
  const initial = create();
  await initial.init();
  await initial.close();
  const db = await request(indexedDB.open(dbName));
  return {
    create,
    patch: (table, id, version) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(table, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        const store = tx.objectStore(table);
        const get = store.get(id);
        get.onsuccess = () =>
          store.put({ ...get.result, schema_version: version });
      }),
    rawCommitted: async (id) =>
      (
        await request(
          db
            .transaction("committed", "readonly")
            .objectStore("committed")
            .get(id),
        )
      ).schema_version,
    close: async () => {
      db.close();
      await request(indexedDB.deleteDatabase(dbName));
    },
  };
};
const invalidVersions = [
  undefined, null, 0, -1, 1.5, 2.9, "2", "2junk", 2n,
  Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
];
const error = { code: "invalid_schema_version" };
const acknowledgement = {
  result: { id: "one", status: "committed", committedId: 1, serverTs: 789 },
};
const committed = (id, committedId, schemaVersion = 2) => ({
  ...draft(id, schemaVersion), committedId, serverTs: 789,
});

for (const adapter of ["sqlite", "libsql", "async-sqlite", "indexeddb"]) {
  describe.skipIf(adapter !== "indexeddb" && !hasNodeSqlite)(adapter, () => {
    const fixture = () =>
      adapter === "indexeddb" ? browserFixture() : sqlFixture(adapter);

    test.each([2, "2", 2n, 999, Number.MAX_SAFE_INTEGER])(
      "normalizes stored %s through draft reads, promotion and replay",
      async (version) => {
        const f = await fixture(), store = f.create();
        try {
          await store.init();
          await store.insertDraft(draft("one"));
          await f.patch("drafts", "one", version);
          const [record] = await store.loadDraftsOrdered();
          expect(record.schemaVersion).toBe(Number(version));
          expect(Object.hasOwn(record, "rawSchemaVersion")).toBe(false);
          expect(await store.listDraftsOrdered()).toEqual([record]);
          await store.applySubmitResult(acknowledgement);
          expect(await f.rawCommitted("one")).toBe(Number(version));
          expect(await store.loadDraftsOrdered()).toEqual([]);
          const [event] = await store.listCommitted();
          expect(event).toMatchObject({
            schemaVersion: Number(version), payload: draft("one").payload, clientTs: 123,
          });
          expect(Object.hasOwn(event, "rawSchemaVersion")).toBe(false);
          await store.applyCommittedBatch({ events: [event], nextCursor: 1 });
          expect(await store.listCommitted()).toEqual([event]);
          await f.patch("committed", "one", version);
          expect((await store.listCommittedAfter({ sinceCommittedId: 0 }))[0].schemaVersion)
            .toBe(Number(version));
        } finally {
          await store.close();
          await f.close();
        }
      },
    );

    test.each([1.5, "1junk", 2.9, "2junk", 0, -1, "not-a-version"])(
      "rejects malformed stored %s without promoting or deleting the draft",
      async (version) => {
        const f = await fixture();
        const store = f.create({ materializedViews: [{
          name: "versions",
          initialState: () => [],
          reduce: ({ state, event }) => [...state, event.schemaVersion],
        }] });
        try {
          await store.init();
          await store.insertDraft(draft("one"));
          await f.patch("drafts", "one", version);
          await expect(store.loadDraftsOrdered()).rejects.toMatchObject(error);
          await expect(store.listDraftsOrdered()).rejects.toMatchObject(error);
          await expect(store.applySubmitResult(acknowledgement)).rejects.toMatchObject(error);
          expect(await store.listCommitted()).toEqual([]);
          // Repairing the version reveals that the rejected promotion kept the draft.
          await f.patch("drafts", "one", 2);
          expect(await store.loadDraftsOrdered()).toHaveLength(1);
          await store.applySubmitResult(acknowledgement);
          await f.patch("committed", "one", version);
          await expect(store.listCommitted()).rejects.toMatchObject(error);
          await expect(store.listCommittedAfter({ sinceCommittedId: 0 })).rejects.toMatchObject(error);
          await expect(store.loadMaterializedView({ viewName: "versions", partition: "main" }))
            .rejects.toMatchObject(error);
        } finally {
          await store.close();
          await f.close();
        }
      },
    );

    test.each(invalidVersions)("rejects newly authored %s before persisting any row", async (version) => {
      const f = await fixture(), store = f.create();
      try {
        await store.init();
        const invalid = { ...draft("invalid"), schemaVersion: version };
        await expect(store.insertDraft(invalid)).rejects.toMatchObject(error);
        await expect(store.insertDrafts([draft("valid"), invalid])).rejects.toMatchObject(error);
        expect(await store.loadDraftsOrdered()).toEqual([]);
      } finally {
        await store.close();
        await f.close();
      }
    });

    test.each(invalidVersions)("rejects received %s without changing rows, drafts, cursor or hot view", async (version) => {
      const f = await fixture();
      const store = f.create({ materializedViews: [{
        name: "versions", initialState: () => [],
        reduce: ({ state, event }) => [...state, event.schemaVersion],
      }] });
      const view = { viewName: "versions", partition: "main" };
      try {
        await store.init();
        await store.applyCommittedBatch({ events: [committed("existing", 1)], nextCursor: 1 });
        await store.insertDraft(draft("pending"));
        expect(await store.loadMaterializedView(view)).toEqual([2]);
        const invalid = { ...committed("invalid", 3), schemaVersion: version };
        await expect(store.applyCommittedBatch({
          events: [committed("pending", 2), invalid], nextCursor: 3,
        })).rejects.toMatchObject(error);
        expect((await store.listCommitted()).map(({ id }) => id)).toEqual(["existing"]);
        expect((await store.loadDraftsOrdered()).map(({ id }) => id)).toEqual(["pending"]);
        expect(await store.loadCursor()).toBe(1);
        expect(await store.loadMaterializedView(view)).toEqual([2]);
      } finally {
        await store.close();
        await f.close();
      }
    });
  });
}

for (const adapter of ["sqlite", "libsql", "async-sqlite"]) {
  test.skipIf(!hasNodeSqlite).each([
    "2\n", "2e0", "9007199254740993", BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  ])(`${adapter} rejects malformed driver version %s`, async (version) => {
    const f = sqlFixture(adapter, () => version), store = f.create();
    try {
      await store.init();
      await store.insertDraft(draft("one"));
      await expect(store.loadDraftsOrdered()).rejects.toMatchObject(error);
      await expect(store.applySubmitResult(acknowledgement)).rejects.toMatchObject(error);
      await store.applyCommittedBatch({ events: [committed("received", 1)], nextCursor: 1 });
      await expect(store.listCommitted()).rejects.toMatchObject(error);
    } finally {
      await store.close();
      await f.close();
    }
  });

  for (const representation of [String, BigInt]) {
    test.skipIf(!hasNodeSqlite)(`${adapter} normalizes ${representation.name} driver versions`, async () => {
      const f = sqlFixture(adapter, representation), store = f.create();
      try {
        await store.init();
        await store.insertDraft(draft("one"));
        expect((await store.loadDraftsOrdered())[0].schemaVersion).toBe(2);
        await store.applySubmitResult(acknowledgement);
        const [record] = await store.listCommitted();
        expect(record.schemaVersion).toBe(2);
        expect(Object.hasOwn(record, "rawSchemaVersion")).toBe(false);
        expect(await f.rawCommitted("one")).toBe(2);
      } finally {
        await store.close();
        await f.close();
      }
    });
  }
}
