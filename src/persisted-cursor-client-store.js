const toNonNegativeInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  return Math.floor(parsed);
};

/**
 * Wrap a client store and persist committed cursor externally.
 *
 * @param {{
 *   store: {
 *     init: () => Promise<void>,
 *     loadCursor: () => Promise<number>,
 *     applyCommittedBatch: (input: { events: object[], nextCursor?: number }) => Promise<void>,
 *   } & Record<string, unknown>,
 *   loadPersistedCursor?: () => Promise<number>,
 *   savePersistedCursor?: (cursor: number) => Promise<void>,
 *   logger?: (entry: object) => void,
 * }} input
 */
export const createPersistedCursorClientStore = ({
  store,
  loadPersistedCursor = async () => 0,
  savePersistedCursor = async () => {},
  logger = () => {},
}) => {
  if (!store || typeof store !== "object") {
    throw new Error("createPersistedCursorClientStore: store is required");
  }
  if (typeof store.init !== "function") {
    throw new Error("createPersistedCursorClientStore: store.init is required");
  }
  if (typeof store.loadCursor !== "function") {
    throw new Error(
      "createPersistedCursorClientStore: store.loadCursor is required",
    );
  }
  if (typeof store.applyCommittedBatch !== "function") {
    throw new Error(
      "createPersistedCursorClientStore: store.applyCommittedBatch is required",
    );
  }

  let persistedCursor = 0;

  const persistCursor = async (candidate) => {
    const normalized = toNonNegativeInteger(candidate);
    if (normalized <= persistedCursor) return persistedCursor;
    persistedCursor = normalized;
    try {
      await savePersistedCursor(normalized);
    } catch (error) {
      logger({
        component: "persisted_cursor_store",
        event: "persist_cursor_failed",
        cursor: normalized,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return persistedCursor;
  };

  return {
    ...store,

    init: async () => {
      await store.init();
      persistedCursor = toNonNegativeInteger(await loadPersistedCursor());
      if (persistedCursor > 0) {
        await store.applyCommittedBatch({
          events: [],
          nextCursor: persistedCursor,
        });
      }
    },

    loadCursor: async () => {
      const current = toNonNegativeInteger(await store.loadCursor());
      return Math.max(current, persistedCursor);
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await store.applyCommittedBatch({ events, nextCursor });
      const current = toNonNegativeInteger(await store.loadCursor());
      const hinted = toNonNegativeInteger(nextCursor);
      await persistCursor(Math.max(current, hinted));
    },
  };
};
