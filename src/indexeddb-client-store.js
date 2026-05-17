import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { throwIfClosed } from "./store-errors.js";
import {
  buildStoredCommittedFromDraft,
  getStoredCommittedId,
  toStoredCommitted,
  toStoredComparisonKey,
  toStoredDraft,
  withStoredCommittedAliases,
  withStoredDraftAliases,
} from "./stored-event.js";

const SCHEMA_VERSION = 8;
const DEFAULT_DB_NAME = "insieme-client";
const META_STORE = "meta";
const DRAFT_STORE = "drafts";
const COMMITTED_STORE = "committed";
const MATERIALIZED_VIEW_STORE = "materialized_view_state";
const CURSOR_KEY = "cursor_committed_id";
const NEXT_DRAFT_CLOCK_KEY = "next_draft_clock";
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 256;

const DRAFT_CLOCK_INDEX = "by_draft_clock";
const COMMITTED_ID_INDEX = "by_committed_id";

const parseIntSafe = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
};

const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("indexeddb request failed"));
  });

const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("indexeddb transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("indexeddb transaction aborted"));
  });

const listAll = async (store) => {
  if (typeof store.getAll === "function") {
    return requestToPromise(store.getAll());
  }

  const items = [];
  await new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      items.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error || new Error("indexeddb cursor failed"));
  });
  return items;
};

const listCommittedAfter = async (
  committedStore,
  sinceCommittedId,
  limit,
  IDBKeyRangeImpl,
) => {
  const index = committedStore.index(COMMITTED_ID_INDEX);
  const keyRange = IDBKeyRangeImpl?.lowerBound(sinceCommittedId, true);
  const items = [];

  await new Promise((resolve, reject) => {
    const request = index.openCursor(keyRange);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || items.length >= limit) {
        resolve();
        return;
      }
      items.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error || new Error("indexeddb cursor failed"));
  });

  return items;
};

const loadLatestCommittedId = async (committedStore) => {
  const index = committedStore.index(COMMITTED_ID_INDEX);
  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      resolve(cursor ? parseIntSafe(cursor.value.committed_id, 0) : 0);
    };
    request.onerror = () =>
      reject(request.error || new Error("indexeddb cursor failed"));
  });
};

const openDatabase = ({ indexedDB, dbName }) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, SCHEMA_VERSION);
    request.onerror = () =>
      reject(request.error || new Error("indexeddb open failed"));
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, {
          keyPath: "key",
        });
      }

      if (db.objectStoreNames.contains(DRAFT_STORE)) {
        db.deleteObjectStore(DRAFT_STORE);
      }
      const draftsStore = db.createObjectStore(DRAFT_STORE, {
        keyPath: "id",
      });
      draftsStore.createIndex(DRAFT_CLOCK_INDEX, "draft_clock", {
        unique: false,
      });

      if (db.objectStoreNames.contains(COMMITTED_STORE)) {
        db.deleteObjectStore(COMMITTED_STORE);
      }
      const committedStore = db.createObjectStore(COMMITTED_STORE, {
        keyPath: "id",
      });
      committedStore.createIndex(COMMITTED_ID_INDEX, "committed_id", {
        unique: true,
      });

      if (db.objectStoreNames.contains(MATERIALIZED_VIEW_STORE)) {
        db.deleteObjectStore(MATERIALIZED_VIEW_STORE);
      }
      db.createObjectStore(MATERIALIZED_VIEW_STORE, {
        keyPath: ["view_name", "partition"],
      });
    };
    request.onsuccess = () => resolve(request.result);
  });

const parseDraftRow = (row) =>
  withStoredDraftAliases({
    draftClock: parseIntSafe(row.draft_clock, 0),
    id: row.id,
    clientId: row.client_id,
    partitions: Array.isArray(row.partitions) ? [...row.partitions] : [],
    event: structuredClone(row.event || {}),
    createdAt: parseIntSafe(row.created_at, 0),
  });

const serializeDraftRow = (draft) => ({
  draft_clock: draft.draftClock,
  id: draft.id,
  client_id: draft.clientId || "unknown",
  partitions: Array.isArray(draft.partitions) ? [...draft.partitions] : [],
  event: structuredClone(draft.event || {}),
  created_at: draft.createdAt,
});

const parseCommittedRow = (row) =>
  withStoredCommittedAliases({
    committed_id: parseIntSafe(row.committed_id, 0),
    id: row.id,
    client_id: row.client_id,
    partitions: Array.isArray(row.partitions) ? [...row.partitions] : [],
    event: structuredClone(row.event || {}),
    status_updated_at: parseIntSafe(row.status_updated_at, 0),
  });

const serializeCommittedRow = (event) => ({
  committed_id: getStoredCommittedId(event),
  id: event.id,
  client_id: event.client_id || event.clientId || "unknown",
  partitions: Array.isArray(event.partitions) ? [...event.partitions] : [],
  event: structuredClone(event.event || {}),
  status_updated_at: event.status_updated_at ?? event.serverTs,
});

const toComparisonKey = (event) => toStoredComparisonKey(event);

export const createIndexedDbClientStore = ({
  indexedDB = globalThis.indexedDB,
  IDBKeyRange = globalThis.IDBKeyRange,
  dbName = DEFAULT_DB_NAME,
  materializedViews,
  materializedBackfillChunkSize = DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE,
} = {}) => {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    throw new Error(
      "createIndexedDbClientStore requires a valid indexedDB implementation",
    );
  }

  /** @type {null|IDBDatabase} */
  let db = null;
  /** @type {null|Promise<void>} */
  let initPromise = null;
  let materializedViewRuntime;
  let closed = false;

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

  const ensureOpen = () => {
    throwIfClosed(closed, "indexeddb client store", "client_store_closed");
  };

  const ensureInitialized = async () => {
    ensureOpen();
    if (db) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      db = await openDatabase({ indexedDB, dbName });
      const tx = db.transaction([META_STORE], "readwrite");
      const metaStore = tx.objectStore(META_STORE);
      const maybeNextDraftClock = await requestToPromise(
        metaStore.get(NEXT_DRAFT_CLOCK_KEY),
      );
      if (!maybeNextDraftClock) {
        metaStore.put({
          key: NEXT_DRAFT_CLOCK_KEY,
          value: "1",
        });
      }
      await transactionDone(tx);

      materializedViewRuntime = createMaterializedViewRuntime({
        definitions: materializedViewDefinitions,
        chunkSize: materializedBackfillChunkSize,
        getLatestCommittedId: async () =>
          withTransaction([COMMITTED_STORE], "readonly", async (stores) =>
            loadLatestCommittedId(stores[COMMITTED_STORE]),
          ),
        listCommittedAfter: async ({ sinceCommittedId, limit }) =>
          withTransaction([COMMITTED_STORE], "readonly", async (stores) => {
            const rows = await listCommittedAfter(
              stores[COMMITTED_STORE],
              sinceCommittedId,
              limit,
              IDBKeyRange,
            );
            return rows.map(parseCommittedRow);
          }),
        loadCheckpoint: async ({ viewName, partition }) =>
          withTransaction([MATERIALIZED_VIEW_STORE], "readonly", async (stores) => {
            const row = await requestToPromise(
              stores[MATERIALIZED_VIEW_STORE].get([viewName, partition]),
            );
            if (!row) return undefined;
            return {
              viewVersion: row.view_version,
              lastCommittedId: parseIntSafe(row.last_committed_id, 0),
              value: row.value,
              updatedAt: parseIntSafe(row.updated_at, 0),
            };
          }),
        saveCheckpoint: async ({
          viewName,
          viewVersion,
          partition,
          value,
          lastCommittedId,
          updatedAt,
        }) => {
          await withTransaction(
            [MATERIALIZED_VIEW_STORE],
            "readwrite",
            async (stores) => {
              stores[MATERIALIZED_VIEW_STORE].put({
                view_name: viewName,
                partition,
                view_version: viewVersion,
                last_committed_id: lastCommittedId,
                value: structuredClone(value),
                updated_at: updatedAt,
              });
            },
          );
        },
        deleteCheckpoint: async ({ viewName, partition }) => {
          await withTransaction(
            [MATERIALIZED_VIEW_STORE],
            "readwrite",
            async (stores) => {
              stores[MATERIALIZED_VIEW_STORE].delete([viewName, partition]);
            },
          );
        },
      });
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  };

  const withTransaction = async (storeNames, mode, run) => {
    await ensureInitialized();
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(
      storeNames.map((storeName) => [storeName, tx.objectStore(storeName)]),
    );

    try {
      const result = await run(stores);
      await transactionDone(tx);
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // best-effort abort
      }
      throw error;
    }
  };

  const loadMetaInt = async (metaStore, key, fallback = 0) => {
    const entry = await requestToPromise(metaStore.get(key));
    if (!entry) return fallback;
    return parseIntSafe(entry.value, fallback);
  };

  const saveMetaInt = async (metaStore, key, value) => {
    metaStore.put({ key, value: String(value) });
  };

  const assertCommittedInvariant = async (
    committedStore,
    committedIdIndex,
    event,
  ) => {
    const existingById = await requestToPromise(committedStore.get(event.id));
    if (existingById) {
      const parsedExistingById = parseCommittedRow(existingById);
      if (
        parsedExistingById.committed_id !== getStoredCommittedId(event) ||
        toComparisonKey(parsedExistingById) !== toComparisonKey(event)
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
      return false;
    }

    const existingByCommittedId = await requestToPromise(
      committedIdIndex.get(getStoredCommittedId(event)),
    );
    if (existingByCommittedId && existingByCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${getStoredCommittedId(event)}: id mismatch`,
      );
    }

    committedStore.add(serializeCommittedRow(event));
    return true;
  };

  return {
    init: async () => {
      await ensureInitialized();
    },

    close: async () => {
      if (closed) return;
      if (initPromise) {
        await initPromise.catch(() => {});
      }
      if (materializedViewRuntime) {
        await materializedViewRuntime.flushMaterializedViews();
        await materializedViewRuntime.close();
      }
      closed = true;
      if (db) {
        db.close();
        db = null;
      }
    },

    loadCursor: async () =>
      withTransaction([META_STORE], "readonly", async (stores) =>
        loadMetaInt(stores[META_STORE], CURSOR_KEY, 0),
      ),

    getCursor: async () =>
      withTransaction([META_STORE], "readonly", async (stores) =>
        loadMetaInt(stores[META_STORE], CURSOR_KEY, 0),
      ),

    insertDrafts: async (items) => {
      await withTransaction(
        [META_STORE, DRAFT_STORE],
        "readwrite",
        async (stores) => {
          const metaStore = stores[META_STORE];
          const draftStore = stores[DRAFT_STORE];
          let draftClock = await loadMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, 1);

          for (const item of items) {
            const draft = toStoredDraft(item);
            const existing = await requestToPromise(draftStore.get(draft.id));
            if (existing) {
              throw new Error(`draft with id ${draft.id} already exists`);
            }

            draftStore.add(serializeDraftRow({
              ...draft,
              draftClock,
            }));
            draftClock += 1;
          }

          await saveMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, draftClock);
        },
      );
    },

    insertDraft: async (item) => {
      await withTransaction(
        [META_STORE, DRAFT_STORE],
        "readwrite",
        async (stores) => {
          const metaStore = stores[META_STORE];
          const draftStore = stores[DRAFT_STORE];
          const draft = toStoredDraft(item);
          const existing = await requestToPromise(draftStore.get(draft.id));
          if (existing) {
            throw new Error(`draft with id ${draft.id} already exists`);
          }

          const draftClock = await loadMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, 1);
          draftStore.add(serializeDraftRow({
            ...draft,
            draftClock,
          }));
          await saveMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, draftClock + 1);
        },
      );
    },

    loadDraftsOrdered: async () =>
      withTransaction([DRAFT_STORE], "readonly", async (stores) => {
        const drafts = (await listAll(stores[DRAFT_STORE])).map(parseDraftRow);
        drafts.sort((left, right) => {
          if (left.draftClock !== right.draftClock) {
            return left.draftClock - right.draftClock;
          }
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
        return drafts;
      }),

    listDraftsOrdered: async () =>
      withTransaction([DRAFT_STORE], "readonly", async (stores) => {
        const drafts = (await listAll(stores[DRAFT_STORE])).map(parseDraftRow);
        drafts.sort((left, right) => {
          if (left.draftClock !== right.draftClock) {
            return left.draftClock - right.draftClock;
          }
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
        return drafts;
      }),

    applySubmitResult: async ({ result }) => {
      const committedEvent = await withTransaction(
        [DRAFT_STORE, COMMITTED_STORE],
        "readwrite",
        async (stores) => {
          const draftStore = stores[DRAFT_STORE];
          const committedStore = stores[COMMITTED_STORE];
          const committedIdIndex = committedStore.index(COMMITTED_ID_INDEX);
          const storedDraft = await requestToPromise(draftStore.get(result.id));
          const draft = storedDraft ? parseDraftRow(storedDraft) : undefined;
          let insertedEvent;

          if (result.status === "committed" && draft) {
            const committed = buildStoredCommittedFromDraft({
              draft,
              result,
            });
            const inserted = await assertCommittedInvariant(
              committedStore,
              committedIdIndex,
              committed,
            );
            if (inserted) {
              insertedEvent = committed;
            }
          }

          if (result.status === "committed" || result.status === "rejected") {
            draftStore.delete(result.id);
          }
          return insertedEvent;
        },
      );

      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      const insertedEvents = await withTransaction(
        [META_STORE, DRAFT_STORE, COMMITTED_STORE],
        "readwrite",
        async (stores) => {
          const metaStore = stores[META_STORE];
          const draftStore = stores[DRAFT_STORE];
          const committedStore = stores[COMMITTED_STORE];
          const committedIdIndex = committedStore.index(COMMITTED_ID_INDEX);
          const inserted = [];

          for (const event of events) {
            const committed = toStoredCommitted(event);
            const wasInserted = await assertCommittedInvariant(
              committedStore,
              committedIdIndex,
              committed,
            );
            if (wasInserted) {
              inserted.push(committed);
            }
            draftStore.delete(event.id);
          }

          if (nextCursor !== undefined) {
            const currentCursor = await loadMetaInt(metaStore, CURSOR_KEY, 0);
            const parsedNextCursor = parseIntSafe(nextCursor, 0);
            await saveMetaInt(
              metaStore,
              CURSOR_KEY,
              Math.max(currentCursor, parsedNextCursor),
            );
          }

          return inserted;
        },
      );

      for (const event of insertedEvents) {
        await materializedViewRuntime.onCommittedEvent(event);
      }
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      return materializedViewRuntime.loadMaterializedView({
        viewName,
        partition,
      });
    },

    subscribeMaterializedView: async ({
      viewName,
      partition,
      onChange,
      emitCurrent,
    }) => {
      await ensureInitialized();
      return materializedViewRuntime.subscribeMaterializedView({
        viewName,
        partition,
        onChange,
        emitCurrent,
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      });
    },

    flushMaterializedViews: async () => {
      await ensureInitialized();
      await materializedViewRuntime.flushMaterializedViews();
    },

    listCommitted: async () =>
      withTransaction([COMMITTED_STORE], "readonly", async (stores) => {
        const committed = (await listAll(stores[COMMITTED_STORE])).map(
          parseCommittedRow,
        );
        committed.sort(
          (left, right) => getStoredCommittedId(left) - getStoredCommittedId(right),
        );
        return committed;
      }),

    listCommittedAfter: async ({
      sinceCommittedId = 0,
      limit = Number.MAX_SAFE_INTEGER,
    } = {}) =>
      withTransaction([COMMITTED_STORE], "readonly", async (stores) => {
        const committed = await listCommittedAfter(
          stores[COMMITTED_STORE],
          sinceCommittedId,
          limit,
          IDBKeyRange,
        );
        return committed.map(parseCommittedRow);
      }),

    _debug: {
      getDrafts: async () =>
        withTransaction([DRAFT_STORE], "readonly", async (stores) =>
          (await listAll(stores[DRAFT_STORE])).map(parseDraftRow),
        ),
      getCommitted: async () =>
        withTransaction([COMMITTED_STORE], "readonly", async (stores) => {
          const committed = (await listAll(stores[COMMITTED_STORE])).map(
            parseCommittedRow,
          );
          committed.sort(
            (left, right) =>
              getStoredCommittedId(left) - getStoredCommittedId(right),
          );
          return committed;
        }),
      getCursor: async () =>
        withTransaction([META_STORE], "readonly", async (stores) =>
          loadMetaInt(stores[META_STORE], CURSOR_KEY, 0),
        ),
    },
  };
};

export const createIndexedDBClientStore = createIndexedDbClientStore;
