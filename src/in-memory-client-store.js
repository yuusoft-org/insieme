import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import {
  buildStoredCommittedFromDraft,
  getStoredCommittedId,
  toStoredCommitted,
  toStoredComparisonKey,
  toStoredDraft,
} from "./stored-event.js";
import { throwIfClosed } from "./store-errors.js";

const sortDrafts = (left, right) => {
  if (left.draftClock !== right.draftClock) {
    return left.draftClock - right.draftClock;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/**
 * In-memory client store implementing the simplified client storage interface.
 */
export const createInMemoryClientStore = ({ materializedViews } = {}) => {
  /** @type {object[]} */
  const drafts = [];

  /** @type {object[]} */
  const committed = [];

  /** @type {Map<string, { comparisonKey: string, committedEvent: object }>} */
  const committedById = new Map();

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);
  const materializedViewRuntime = createMaterializedViewRuntime({
    definitions: materializedViewDefinitions,
    getLatestCommittedId: async () =>
      committed.length === 0
        ? 0
        : getStoredCommittedId(committed[committed.length - 1]),
    listCommittedAfter: async ({ sinceCommittedId, limit }) =>
      committed
        .filter((event) => getStoredCommittedId(event) > sinceCommittedId)
        .slice(0, limit),
  });

  let nextDraftClock = 1;
  let cursor = 0;
  let closed = false;

  const ensureOpen = () => {
    throwIfClosed(closed, "in-memory client store", "client_store_closed");
  };

  const getCommittedSnapshot = () => [...committed];

  const getCommittedAfter = (
    sinceCommittedId = 0,
    limit = Number.MAX_SAFE_INTEGER,
  ) =>
    committed
      .filter((event) => getStoredCommittedId(event) > sinceCommittedId)
      .slice(0, limit);

  const removeDraftById = (id) => {
    const index = drafts.findIndex((entry) => entry.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  const toCommittedRecord = (event) => toStoredCommitted(event);

  const toComparisonKey = (event) => toStoredComparisonKey(event);

  const upsertCommitted = (event) => {
    const normalizedEvent = toCommittedRecord(event);
    const existing = committedById.get(normalizedEvent.id);
    const comparisonKey = toComparisonKey(normalizedEvent);
    if (existing) {
      if (
        getStoredCommittedId(existing.committedEvent) !==
          getStoredCommittedId(normalizedEvent) ||
        existing.comparisonKey !== comparisonKey
      ) {
        throw new Error(
          `committed event invariant violation for id ${normalizedEvent.id}: conflicting duplicate`,
        );
      }
      return false;
    }

    committedById.set(normalizedEvent.id, {
      comparisonKey,
      committedEvent: normalizedEvent,
    });
    committed.push(normalizedEvent);
    committed.sort(
      (left, right) => getStoredCommittedId(left) - getStoredCommittedId(right),
    );
    return true;
  };

  return {
    init: async () => {
      ensureOpen();
    },

    close: async () => {
      if (closed) return;
      closed = true;
      await materializedViewRuntime.close();
    },

    loadCursor: async () => {
      ensureOpen();
      return cursor;
    },

    getCursor: async () => {
      ensureOpen();
      return cursor;
    },

    insertDrafts: async (items) => {
      ensureOpen();
      const seenIds = new Set();
      const nextDrafts = items.map((item) => {
        const draft = toStoredDraft(item);
        if (seenIds.has(draft.id)) {
          throw new Error(`draft with id ${draft.id} already exists`);
        }
        seenIds.add(draft.id);
        const existing = drafts.find((entry) => entry.id === draft.id);
        if (existing) {
          throw new Error(`draft with id ${draft.id} already exists`);
        }

        return {
          ...draft,
          draftClock: nextDraftClock,
        };
      });

      for (const draft of nextDrafts) {
        drafts.push(draft);
        nextDraftClock += 1;
      }
    },

    insertDraft: async (item) => {
      ensureOpen();
      const draft = toStoredDraft(item);
      const existing = drafts.find((entry) => entry.id === draft.id);
      if (existing) {
        throw new Error(`draft with id ${draft.id} already exists`);
      }

      drafts.push({
        ...draft,
        draftClock: nextDraftClock,
      });
      nextDraftClock += 1;
    },

    loadDraftsOrdered: async () => {
      ensureOpen();
      return [...drafts].sort(sortDrafts);
    },

    listDraftsOrdered: async () => {
      ensureOpen();
      return [...drafts].sort(sortDrafts);
    },

    applySubmitResult: async ({ result }) => {
      ensureOpen();
      if (result.status === "committed") {
        const draft = drafts.find((entry) => entry.id === result.id);
        if (draft) {
          const committedEvent = toCommittedRecord(
            buildStoredCommittedFromDraft({
              draft,
              result,
            }),
          );
          if (upsertCommitted(committedEvent)) {
            await materializedViewRuntime.onCommittedEvent(committedEvent);
          }
        }
        removeDraftById(result.id);
        return;
      }

      if (result.status === "rejected") {
        removeDraftById(result.id);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      ensureOpen();
      for (const event of events) {
        const committedEvent = toCommittedRecord(event);
        const inserted = upsertCommitted(committedEvent);
        if (inserted) {
          await materializedViewRuntime.onCommittedEvent(committedEvent);
        }
        removeDraftById(event.id);
      }

      if (nextCursor !== undefined) cursor = Math.max(cursor, nextCursor);
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
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
      ensureOpen();
      return materializedViewRuntime.subscribeMaterializedView({
        viewName,
        partition,
        onChange,
        emitCurrent,
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
      return materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
      return materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      });
    },

    flushMaterializedViews: async () => {
      ensureOpen();
      await materializedViewRuntime.flushMaterializedViews();
    },

    listCommitted: async () => {
      ensureOpen();
      return getCommittedSnapshot();
    },

    listCommittedAfter: async ({
      sinceCommittedId = 0,
      limit = Number.MAX_SAFE_INTEGER,
    } = {}) => {
      ensureOpen();
      return getCommittedAfter(sinceCommittedId, limit);
    },

    _debug: {
      getDrafts: () => {
        ensureOpen();
        return [...drafts].sort(sortDrafts);
      },
      getCommitted: () => {
        ensureOpen();
        return getCommittedSnapshot();
      },
      getCursor: () => {
        ensureOpen();
        return cursor;
      },
      getMaterializedViewNames: () =>
        materializedViewDefinitions.map((definition) => definition.name),
    },
  };
};
