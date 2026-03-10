import { canonicalizeSubmitItem } from "./canonicalize.js";
import { buildCommittedEventFromDraft, normalizeMeta } from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";

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
  /** @type {{ draftClock: number, id: string, partitions: string[], projectId?: string, userId?: string, type: string, payload: object, meta: object, createdAt: number }[]} */
  const drafts = [];

  /** @type {{ committedId: number, id: string, projectId?: string, userId?: string, partitions: string[], type: string, payload: object, meta: object, created: number }[]} */
  const committed = [];

  /** @type {Map<string, { comparisonKey: string, committedEvent: { committedId: number, id: string, projectId?: string, userId?: string, partitions: string[], type: string, payload: object, meta: object, created: number } }>} */
  const committedById = new Map();

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);
  const materializedViewRuntime = createMaterializedViewRuntime({
    definitions: materializedViewDefinitions,
    getLatestCommittedId: async () =>
      committed.length === 0
        ? 0
        : committed[committed.length - 1].committedId,
    listCommittedAfter: async ({ sinceCommittedId, limit }) =>
      committed
        .filter((event) => event.committedId > sinceCommittedId)
        .slice(0, limit),
  });

  let nextDraftClock = 1;
  let cursor = 0;

  const removeDraftById = (id) => {
    const index = drafts.findIndex((entry) => entry.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  const toComparisonKey = (event) =>
    canonicalizeSubmitItem({
      partitions: event.partitions,
      projectId: event.projectId,
      userId: event.userId,
      type: event.type,
      payload: event.payload,
      meta: event.meta,
    });

  const upsertCommitted = (event) => {
    const normalizedEvent = {
      ...event,
      payload: structuredClone(event.payload),
      meta: normalizeMeta(event.meta),
    };
    const existing = committedById.get(normalizedEvent.id);
    const comparisonKey = toComparisonKey(normalizedEvent);
    if (existing) {
      if (
        existing.committedEvent.committedId !== normalizedEvent.committedId ||
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
    committed.sort((left, right) => left.committedId - right.committedId);
    return true;
  };

  return {
    init: async () => {},

    loadCursor: async () => cursor,

    insertDraft: async ({
      id,
      partitions,
      projectId,
      userId,
      type,
      payload,
      meta,
      createdAt,
    }) => {
      const existing = drafts.find((entry) => entry.id === id);
      if (existing) {
        throw new Error(`draft with id ${id} already exists`);
      }

      drafts.push({
        draftClock: nextDraftClock,
        id,
        partitions: [...partitions],
        projectId,
        userId,
        type,
        payload: structuredClone(payload),
        meta: normalizeMeta(meta),
        createdAt,
      });
      nextDraftClock += 1;
    },

    loadDraftsOrdered: async () => [...drafts].sort(sortDrafts),

    applySubmitResult: async ({ result }) => {
      if (result.status === "committed") {
        const draft = drafts.find((entry) => entry.id === result.id);
        if (draft) {
          const committedEvent = buildCommittedEventFromDraft({
            draft,
            committedId: result.committedId,
            created: result.created,
          });
          if (upsertCommitted(committedEvent)) {
            await materializedViewRuntime.onCommittedEvent(committedEvent);
          }
        }
      }

      removeDraftById(result.id);
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      for (const event of events) {
        const inserted = upsertCommitted(event);
        if (inserted) {
          await materializedViewRuntime.onCommittedEvent(event);
        }
        removeDraftById(event.id);
      }

      if (nextCursor !== undefined) cursor = Math.max(cursor, nextCursor);
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      return materializedViewRuntime.loadMaterializedView({
        viewName,
        partition,
      });
    },

    loadMaterializedViews: async ({ viewName, partitions }) =>
      materializedViewRuntime.loadMaterializedViews({
        viewName,
        partitions,
      }),

    evictMaterializedView: async ({ viewName, partition }) =>
      materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      }),

    invalidateMaterializedView: async ({ viewName, partition }) =>
      materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      }),

    flushMaterializedViews: async () => {
      await materializedViewRuntime.flushMaterializedViews();
    },

    _debug: {
      getDrafts: () => [...drafts].sort(sortDrafts),
      getCommitted: () => [...committed],
      getCursor: () => cursor,
      getMaterializedViewNames: () =>
        materializedViewDefinitions.map((definition) => definition.name),
    },
  };
};
