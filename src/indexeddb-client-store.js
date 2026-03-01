import { canonicalizeSubmitItem } from "./canonicalize.js";

const SCHEMA_VERSION = 1;
const DEFAULT_DB_NAME = "insieme-client";
const META_STORE = "meta";
const DRAFT_STORE = "drafts";
const COMMITTED_STORE = "committed";
const CURSOR_KEY = "cursor_committed_id";
const NEXT_DRAFT_CLOCK_KEY = "next_draft_clock";

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

      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        const draftsStore = db.createObjectStore(DRAFT_STORE, {
          keyPath: "id",
        });
        draftsStore.createIndex("by_draft_clock", "draftClock", {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains(COMMITTED_STORE)) {
        const committedStore = db.createObjectStore(COMMITTED_STORE, {
          keyPath: "id",
        });
        committedStore.createIndex("by_committed_id", "committed_id", {
          unique: true,
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });

export const createIndexedDbClientStore = ({
  indexedDB = globalThis.indexedDB,
  dbName = DEFAULT_DB_NAME,
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

  const ensureInitialized = async () => {
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
    const canonical = canonicalizeSubmitItem({
      partitions: event.partitions,
      event: event.event,
    });

    const existingById = await requestToPromise(committedStore.get(event.id));
    if (existingById) {
      if (
        existingById.committed_id !== event.committed_id ||
        existingById.client_id !== event.client_id ||
        existingById.canonical !== canonical
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
      return false;
    }

    const existingByCommittedId = await requestToPromise(
      committedIdIndex.get(event.committed_id),
    );
    if (existingByCommittedId && existingByCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committed_id ${event.committed_id}: id mismatch`,
      );
    }

    committedStore.add({
      ...event,
      canonical,
    });
    return true;
  };

  return {
    init: async () => {
      await ensureInitialized();
    },

    loadCursor: async () =>
      withTransaction([META_STORE], "readonly", async (stores) =>
        loadMetaInt(stores[META_STORE], CURSOR_KEY, 0),
      ),

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      await withTransaction(
        [META_STORE, DRAFT_STORE],
        "readwrite",
        async (stores) => {
          const metaStore = stores[META_STORE];
          const draftStore = stores[DRAFT_STORE];
          const existing = await requestToPromise(draftStore.get(id));
          if (existing) {
            throw new Error(`draft with id ${id} already exists`);
          }

          const draftClock = await loadMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, 1);
          draftStore.add({
            id,
            draftClock,
            clientId,
            partitions: [...partitions],
            event,
            createdAt,
          });
          await saveMetaInt(metaStore, NEXT_DRAFT_CLOCK_KEY, draftClock + 1);
        },
      );
    },

    loadDraftsOrdered: async () =>
      withTransaction([DRAFT_STORE], "readonly", async (stores) => {
        const drafts = await listAll(stores[DRAFT_STORE]);
        drafts.sort((left, right) => {
          if (left.draftClock !== right.draftClock) {
            return left.draftClock - right.draftClock;
          }
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
        return drafts.map((draft) => ({
          ...draft,
          partitions: [...draft.partitions],
        }));
      }),

    applySubmitResult: async ({ result, fallbackClientId }) => {
      await withTransaction(
        [DRAFT_STORE, COMMITTED_STORE],
        "readwrite",
        async (stores) => {
          const draftStore = stores[DRAFT_STORE];
          const committedStore = stores[COMMITTED_STORE];
          const committedIdIndex = committedStore.index("by_committed_id");
          const draft = await requestToPromise(draftStore.get(result.id));

          if (result.status === "committed" && draft) {
            await assertCommittedInvariant(committedStore, committedIdIndex, {
              committed_id: result.committed_id,
              id: draft.id,
              client_id: draft.clientId || fallbackClientId,
              partitions: [...draft.partitions],
              event: draft.event,
              status_updated_at: result.status_updated_at,
            });
          }

          draftStore.delete(result.id);
        },
      );
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await withTransaction(
        [META_STORE, DRAFT_STORE, COMMITTED_STORE],
        "readwrite",
        async (stores) => {
          const metaStore = stores[META_STORE];
          const draftStore = stores[DRAFT_STORE];
          const committedStore = stores[COMMITTED_STORE];
          const committedIdIndex = committedStore.index("by_committed_id");

          for (const event of events) {
            await assertCommittedInvariant(committedStore, committedIdIndex, event);
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
        },
      );
    },

    _debug: {
      getDrafts: async () =>
        withTransaction([DRAFT_STORE], "readonly", async (stores) =>
          listAll(stores[DRAFT_STORE]),
        ),
      getCommitted: async () =>
        withTransaction([COMMITTED_STORE], "readonly", async (stores) => {
          const committed = await listAll(stores[COMMITTED_STORE]);
          committed.sort(
            (left, right) => left.committed_id - right.committed_id,
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
