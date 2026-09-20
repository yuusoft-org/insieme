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

const createStore = (adapter, options) => {
  switch (adapter) {
    case "sqlite":
      return createSqliteClientStore(createSqliteDb(), options);
    case "libsql":
      return createLibsqlClientStore(createLibsqlClient(), options);
    case "async-sqlite":
      return createAsyncSqliteClientStore({
        driver: createAsyncSqliteDriver(),
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
    test.each([false, true])(
      "live and rebuilt views agree with includeRawSchemaVersion=%s",
      async (includeRawSchemaVersion) => {
        const store = createStore(adapter, {
          includeRawSchemaVersion,
          materializedViews: [{
            name: "versions",
            initialState: () => [],
            reduce: ({ state, event }) => {
              expect(Object.hasOwn(event, "rawSchemaVersion")).toBe(
                includeRawSchemaVersion,
              );
              if (includeRawSchemaVersion) {
                expect(event.rawSchemaVersion).toBe(event.schemaVersion);
              }
              return [...state, event.schemaVersion];
            },
          }],
        });
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
          await store.applyCommittedBatch({ events, nextCursor: 2 });
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
