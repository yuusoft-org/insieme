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

const withVersionRepresentation = (driver, adapter, representation) => {
  const convert = (row) =>
    row && Object.hasOwn(row, "schema_version")
      ? { ...row, schema_version: representation(row.schema_version) }
      : row;
  if (adapter === "sqlite") {
    return {
      ...driver,
      prepare: (sql) => {
        const stmt = driver.prepare(sql);
        return {
          ...stmt,
          get: (params) => convert(stmt.get(params)),
          all: (params) => stmt.all(params).map(convert),
        };
      },
    };
  }
  if (adapter === "libsql") {
    return {
      ...driver,
      execute: async (statement) => {
        const result = await driver.execute(statement);
        return { ...result, rows: result.rows.map(convert) };
      },
    };
  }
  return {
    ...driver,
    transaction: (mode, run) =>
      driver.transaction(mode, (tx) => run({
        ...tx,
        query: async (sql, args) => (await tx.query(sql, args)).map(convert),
      })),
  };
};

const createStore = (adapter, options, representation) => {
  const wrap = (driver) =>
    withVersionRepresentation(driver, adapter, representation);
  switch (adapter) {
    case "sqlite":
      return createSqliteClientStore(wrap(createSqliteDb()), options);
    case "libsql":
      return createLibsqlClientStore(wrap(createLibsqlClient()), options);
    case "async-sqlite":
      return createAsyncSqliteClientStore({
        driver: wrap(createAsyncSqliteDriver()),
        ...options,
      });
    default:
      return createIndexedDbClientStore({
        indexedDB,
        IDBKeyRange,
        dbName: `schema-version-views-${crypto.randomUUID()}`,
        ...options,
      });
  }
};

for (const adapter of ["sqlite", "libsql", "async-sqlite", "indexeddb"]) {
  describe.skipIf(adapter !== "indexeddb" && !hasNodeSqlite)(adapter, () => {
    const representations =
      adapter === "indexeddb" ? [Number] : [Number, String, BigInt];
    const cases = representations.flatMap((representation) =>
      ["batch", "acknowledgment"].map((path) => ({
        representation,
        representationName: representation.name,
        path,
      })),
    );
    test.each(cases)(
      "live and rebuilt views use numeric versions for $representationName drivers via $path",
      async ({ representation, path }) => {
        const store = createStore(adapter, {
          materializedViews: [{
            name: "versions",
            initialState: () => [],
            reduce: ({ state, event }) => {
              expect(typeof event.schemaVersion).toBe("number");
              expect(Object.hasOwn(event, "rawSchemaVersion")).toBe(false);
              return [...state, event.schemaVersion];
            },
          }],
        }, representation);
        const view = { viewName: "versions", partition: "main" };
        const events = [1, 2].map((schemaVersion) => ({
          id: `event-${schemaVersion}`,
          committedId: schemaVersion,
          partition: "main",
          type: "change",
          schemaVersion,
          payload: {},
          clientTs: 123,
          serverTs: 456,
        }));
        const originalEvents = structuredClone(events);

        try {
          await store.init();
          // Warm the view so the batch reaches the live reducer path.
          expect(await store.loadMaterializedView(view)).toEqual([]);
          if (path === "batch") {
            await store.applyCommittedBatch({ events, nextCursor: 2 });
          } else {
            for (const event of events) {
              await store.insertDraft({ ...event, createdAt: 123 });
              await store.applySubmitResult({ result: {
                id: event.id,
                committedId: event.committedId,
                serverTs: event.serverTs,
                status: "committed",
              } });
            }
          }
          const live = await store.loadMaterializedView(view);
          expect(live).toEqual([1, 2]);
          expect(events).toEqual(originalEvents);

          await store.applyCommittedBatch({ events, nextCursor: 2 });
          expect(await store.loadMaterializedView(view)).toEqual(live);

          await store.flushMaterializedViews();
          await store.evictMaterializedView(view);
          expect(await store.loadMaterializedView(view)).toEqual(live);

          // Remove the checkpoint to force the same events through replay.
          await store.invalidateMaterializedView(view);
          expect(await store.loadMaterializedView(view)).toEqual(live);
        } finally {
          await store.close();
        }
      },
    );
  });
}
