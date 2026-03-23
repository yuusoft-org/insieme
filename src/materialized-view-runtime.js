import {
  applyMaterializedViewReducer,
  cloneMaterializedViewValue,
  createMaterializedViewInitialState,
  normalizeMaterializedViewDefinitions,
} from "./materialized-view.js";

const DEFAULT_CHUNK_SIZE = 256;

const normalizeChunkSize = (value) => {
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  return value;
};

const toUniqueSortedKeys = (keys = []) => [...new Set(keys)].sort();

const createHotEntry = ({
  state,
  lastCommittedId = 0,
  persistedLastCommittedId = 0,
  updatedAt = 0,
}) => ({
  state,
  lastCommittedId,
  persistedLastCommittedId,
  updatedAt,
  dirtyEventCount: 0,
  flushTimer: undefined,
});

const isDirty = (entry) => entry.lastCommittedId > entry.persistedLastCommittedId;

const clearFlushTimer = (entry) => {
  if (!entry?.flushTimer) return;
  clearTimeout(entry.flushTimer);
  entry.flushTimer = undefined;
};

export const createMaterializedViewRuntime = ({
  definitions,
  materializedViews,
  getLatestCommittedId,
  listCommittedAfter,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  chunkSize,
  now = () => Date.now(),
} = {}) => {
  const normalizedDefinitions =
    definitions ?? normalizeMaterializedViewDefinitions(materializedViews);
  const normalizedChunkSize = normalizeChunkSize(chunkSize);
  const definitionByName = new Map(
    (normalizedDefinitions || []).map((definition) => [definition.name, definition]),
  );
  const hotEntriesByView = new Map(
    (normalizedDefinitions || []).map((definition) => [definition.name, new Map()]),
  );
  const lockTails = new Map();
  let pendingBackgroundError;

  const assertHealthy = () => {
    if (!pendingBackgroundError) return;
    const error = pendingBackgroundError;
    pendingBackgroundError = undefined;
    throw error;
  };

  const recordBackgroundError = (error) => {
    if (!pendingBackgroundError) {
      pendingBackgroundError = error;
    }
  };

  const getDefinition = (viewName) => {
    const definition = definitionByName.get(viewName);
    if (!definition) {
      throw new Error(`unknown materialized view '${viewName}'`);
    }
    return definition;
  };

  const assertPartition = (partition, methodName) => {
    if (typeof partition !== "string" || partition.length === 0) {
      throw new Error(`${methodName} requires a non-empty partition`);
    }
  };

  const getHotEntries = (viewName) => {
    const entries = hotEntriesByView.get(viewName);
    if (!entries) {
      throw new Error(`unknown materialized view '${viewName}'`);
    }
    return entries;
  };

  const toLockKey = (viewName, partition) => `${viewName}::${partition}`;

  const definitionMatchesPartition = (definition, loadedPartition, event) =>
    definition.matchesPartition({
      loadedPartition,
      eventPartition: event?.partition,
      event,
    });

  const acquireLock = async (lockKey) => {
    const previousTail = lockTails.get(lockKey) || Promise.resolve();
    let releaseCurrent;
    const currentLock = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const currentTail = previousTail.catch(() => {}).then(() => currentLock);
    lockTails.set(lockKey, currentTail);
    await previousTail.catch(() => {});

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (lockTails.get(lockKey) === currentTail) {
        lockTails.delete(lockKey);
      }
    };
  };

  const withLocks = async (lockKeys, run) => {
    const releases = [];
    const uniqueLockKeys = toUniqueSortedKeys(lockKeys);

    try {
      for (const lockKey of uniqueLockKeys) {
        releases.push(await acquireLock(lockKey));
      }
      return await run();
    } finally {
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        releases[index]();
      }
    }
  };

  const persistEntry = async (definition, partition, entry) => {
    if (typeof saveCheckpoint !== "function" || !isDirty(entry)) return;
    await saveCheckpoint({
      viewName: definition.name,
      viewVersion: definition.version,
      partition,
      value: entry.state,
      lastCommittedId: entry.lastCommittedId,
      updatedAt: entry.updatedAt || now(),
    });
    entry.persistedLastCommittedId = entry.lastCommittedId;
    entry.dirtyEventCount = 0;
  };

  const flushEntry = async (definition, partition, entry) => {
    clearFlushTimer(entry);
    await persistEntry(definition, partition, entry);
  };

  const scheduleFlush = async (definition, partition, entry) => {
    if (!isDirty(entry) || typeof saveCheckpoint !== "function") return;

    const checkpoint = definition.checkpoint;
    const maxDirtyEvents = checkpoint.maxDirtyEvents;
    if (
      Number.isInteger(maxDirtyEvents) &&
      maxDirtyEvents > 0 &&
      entry.dirtyEventCount >= maxDirtyEvents
    ) {
      await flushEntry(definition, partition, entry);
      return;
    }

    if (checkpoint.mode === "manual") return;
    if (checkpoint.mode === "immediate") {
      await flushEntry(definition, partition, entry);
      return;
    }

    if (checkpoint.mode === "debounce") {
      clearFlushTimer(entry);
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = undefined;
        withLocks([toLockKey(definition.name, partition)], async () => {
          const liveEntry = getHotEntries(definition.name).get(partition);
          if (liveEntry !== entry) return;
          await flushEntry(definition, partition, entry);
        }).catch(recordBackgroundError);
      }, checkpoint.debounceMs);
      return;
    }

    if (checkpoint.mode === "interval" && !entry.flushTimer) {
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = undefined;
        withLocks([toLockKey(definition.name, partition)], async () => {
          const liveEntry = getHotEntries(definition.name).get(partition);
          if (liveEntry !== entry) return;
          await flushEntry(definition, partition, entry);
        }).catch(recordBackgroundError);
      }, checkpoint.intervalMs);
    }
  };

  const hydrateEntry = async ({
    definition,
    partition,
    targetCommittedId,
  }) => {
    const hotEntries = getHotEntries(definition.name);
    let entry = hotEntries.get(partition);
    if (!entry) {
      let checkpoint;
      if (typeof loadCheckpoint === "function") {
        checkpoint = await loadCheckpoint({
          viewName: definition.name,
          partition,
        });
      }

      if (checkpoint && checkpoint.viewVersion !== definition.version) {
        if (typeof deleteCheckpoint === "function") {
          await deleteCheckpoint({
            viewName: definition.name,
            partition,
          });
        }
        checkpoint = undefined;
      }

      entry = createHotEntry({
        state: checkpoint
          ? checkpoint.value
          : createMaterializedViewInitialState(definition, partition),
        lastCommittedId: checkpoint?.lastCommittedId ?? 0,
        persistedLastCommittedId: checkpoint?.lastCommittedId ?? 0,
        updatedAt: checkpoint?.updatedAt ?? 0,
      });
      hotEntries.set(partition, entry);
    }

    const minCommittedId =
      targetCommittedId > entry.lastCommittedId ? entry.lastCommittedId : undefined;

    if (minCommittedId === undefined) return entry;

    let cursor = minCommittedId;
    while (cursor < targetCommittedId) {
      const events = await listCommittedAfter({
        sinceCommittedId: cursor,
        limit: normalizedChunkSize,
      });
      if (!events || events.length === 0) break;

      for (const event of events) {
        if (
          definitionMatchesPartition(definition, partition, event) &&
          event.committedId > entry.lastCommittedId
        ) {
          entry.state = applyMaterializedViewReducer(definition, entry.state, event, partition);
          entry.lastCommittedId = event.committedId;
          entry.updatedAt = event.serverTs || now();
          entry.dirtyEventCount += 1;
        }
        cursor = event.committedId;
      }

      if (events.length < normalizedChunkSize) break;
    }

    await scheduleFlush(definition, partition, entry);
    return entry;
  };

  return {
    loadMaterializedView: async ({ viewName, partition }) => {
      assertHealthy();
      assertPartition(partition, "loadMaterializedView");
      const definition = getDefinition(viewName);
      return withLocks([toLockKey(viewName, partition)], async () => {
        const targetCommittedId = await getLatestCommittedId();
        const entry = await hydrateEntry({
          definition,
          partition,
          targetCommittedId,
        });
        return cloneMaterializedViewValue(entry?.state);
      });
    },

    onCommittedEvent: async (event) => {
      assertHealthy();
      if (
        !event ||
        typeof event.partition !== "string" ||
        event.partition.length === 0
      ) {
        return;
      }

      const lockKeys = [];
      for (const definition of normalizedDefinitions || []) {
        const hotEntries = getHotEntries(definition.name);
        for (const loadedPartition of hotEntries.keys()) {
          if (definitionMatchesPartition(definition, loadedPartition, event)) {
            lockKeys.push(toLockKey(definition.name, loadedPartition));
          }
        }
      }

      await withLocks(lockKeys, async () => {
        for (const definition of normalizedDefinitions || []) {
          const hotEntries = getHotEntries(definition.name);
          for (const [loadedPartition, entry] of hotEntries) {
            if (
              !definitionMatchesPartition(definition, loadedPartition, event) ||
              event.committedId <= entry.lastCommittedId
            ) {
              continue;
            }
            entry.state = applyMaterializedViewReducer(
              definition,
              entry.state,
              event,
              loadedPartition,
            );
            entry.lastCommittedId = event.committedId;
            entry.updatedAt = event.serverTs || now();
            entry.dirtyEventCount += 1;
            await scheduleFlush(definition, loadedPartition, entry);
          }
        }
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      assertHealthy();
      assertPartition(partition, "evictMaterializedView");
      const definition = getDefinition(viewName);
      await withLocks([toLockKey(viewName, partition)], async () => {
        const hotEntries = getHotEntries(definition.name);
        const entry = hotEntries.get(partition);
        if (!entry) return;
        clearFlushTimer(entry);
        hotEntries.delete(partition);
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      assertHealthy();
      assertPartition(partition, "invalidateMaterializedView");
      const definition = getDefinition(viewName);
      await withLocks([toLockKey(viewName, partition)], async () => {
        const hotEntries = getHotEntries(definition.name);
        const entry = hotEntries.get(partition);
        if (entry) {
          clearFlushTimer(entry);
          hotEntries.delete(partition);
        }
        if (typeof deleteCheckpoint === "function") {
          await deleteCheckpoint({
            viewName: definition.name,
            partition,
          });
        }
      });
    },

    flushMaterializedViews: async () => {
      assertHealthy();
      for (const definition of normalizedDefinitions || []) {
        const hotEntries = getHotEntries(definition.name);
        for (const [partition, entry] of hotEntries) {
          await withLocks([toLockKey(definition.name, partition)], async () => {
            const liveEntry = getHotEntries(definition.name).get(partition);
            if (liveEntry !== entry) return;
            await flushEntry(definition, partition, entry);
          });
        }
      }
      assertHealthy();
    },
  };
};
