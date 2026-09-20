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
  const create = (includeRawSchemaVersion) =>
    adapter === "sqlite"
      ? createSqliteClientStore(shared, { includeRawSchemaVersion })
      : adapter === "libsql"
        ? createLibsqlClientStore(shared, { includeRawSchemaVersion })
        : createAsyncSqliteClientStore({
            driver: shared,
            includeRawSchemaVersion,
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
  const create = (includeRawSchemaVersion) =>
    createIndexedDbClientStore({
      indexedDB,
      IDBKeyRange,
      dbName,
      includeRawSchemaVersion,
    });
  const initial = create(false);
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
for (const adapter of ["sqlite", "libsql", "async-sqlite", "indexeddb"])
  describe.skipIf(adapter !== "indexeddb" && !hasNodeSqlite)(adapter, () => {
    const fixture = () =>
      adapter === "indexeddb" ? browserFixture() : sqlFixture(adapter);
    test.each([1.5, "1junk", 2.9, "2junk", 0, -1, 2, 999, "not-a-version"])(
      "retains original %s for drafts and committed rows without changing the default reader",
      async (version) => {
        const f = await fixture();
        const legacy = f.create(false),
          raw = f.create(true);
        try {
          await legacy.init();
          await raw.init();
          await legacy.insertDraft(draft("draft"));
          await f.patch("drafts", "draft", version);
          const oldDraft = (await legacy.loadDraftsOrdered())[0];
          const rawDraft = (await raw.loadDraftsOrdered())[0];
          expect(Object.hasOwn(oldDraft, "rawSchemaVersion")).toBe(false);
          expect(rawDraft).toEqual({ ...oldDraft, rawSchemaVersion: version });
          await raw.applySubmitResult({
            result: {
              id: "draft",
              status: "committed",
              committedId: 1,
              serverTs: 789,
            },
          });
          expect(await f.rawCommitted("draft")).toBe(version);
          const oldCommitted = (await legacy.listCommitted())[0];
          const rawCommitted = (await raw.listCommitted())[0];
          expect(rawCommitted).toEqual({
            ...oldCommitted,
            rawSchemaVersion: version,
          });
          expect(rawCommitted.payload).toEqual(draft("draft").payload);
          expect(rawCommitted.clientTs).toBe(123);
          expect(await raw.loadDraftsOrdered()).toEqual([]);
          // Imported/received committed rows use the same raw-preserving readers.
          await f.patch("committed", "draft", "2junk");
          expect(
            (await raw.listCommittedAfter({ sinceCommittedId: 0 }))[0],
          ).toMatchObject({ schemaVersion: 2, rawSchemaVersion: "2junk" });
        } finally {
          await legacy.close();
          await raw.close();
          await f.close();
        }
      },
    );
    test.each([
      undefined,
      null,
      0,
      -1,
      1.5,
      2.9,
      "2",
      "2junk",
      2n,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
    ])(
      "rejects newly authored %s before persisting any row",
      async (version) => {
        const f = await fixture(),
          store = f.create(true);
        try {
          await store.init();
          const invalid = {
            ...draft("invalid"),
            schemaVersion: version,
            rawSchemaVersion: 2,
          };
          await expect(store.insertDraft(invalid)).rejects.toMatchObject({
            code: "invalid_schema_version",
          });
          await expect(
            store.insertDrafts([draft("valid"), invalid]),
          ).rejects.toMatchObject({ code: "invalid_schema_version" });
          expect(await store.loadDraftsOrdered()).toEqual([]);
        } finally {
          await store.close();
          await f.close();
        }
      },
    );
    test("strict wrapped payload survives commit, exact duplicate and reload", async () => {
      const f = await fixture(),
        store = f.create(true);
      try {
        await store.init();
        await store.insertDraft(draft("one"));
        await store.applySubmitResult({
          result: {
            id: "one",
            status: "committed",
            committedId: 1,
            serverTs: 789,
          },
        });
        const [record] = await store.listCommitted();
        await store.applyCommittedBatch({ events: [record], nextCursor: 1 });
        expect(await store.listCommitted()).toEqual([record]);
        expect(record).toMatchObject({
          schemaVersion: 2,
          rawSchemaVersion: 2,
          payload: draft("one").payload,
        });
      } finally {
        await store.close();
        await f.close();
      }
    });
  });

for (const adapter of ["sqlite", "libsql", "async-sqlite"])
  for (const representation of [String, BigInt])
    test.skipIf(!hasNodeSqlite)(
      `${adapter} preserves ${representation.name} driver versions losslessly`,
      async () => {
        const f = sqlFixture(adapter, representation),
          store = f.create(true);
        try {
          await store.init();
          await store.insertDraft(draft("one"));
          expect((await store.loadDraftsOrdered())[0]).toMatchObject({
            schemaVersion: 2,
            rawSchemaVersion: representation(2),
          });
          await store.applySubmitResult({
            result: {
              id: "one",
              status: "committed",
              committedId: 1,
              serverTs: 789,
            },
          });
          expect((await store.listCommitted())[0]).toMatchObject({
            schemaVersion: 2,
            rawSchemaVersion: representation(2),
          });
        } finally {
          await store.close();
          await f.close();
        }
      },
    );
