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
  /** @type {{ draftClock: number, id: string, partition: string, projectId?: string, userId?: string, type: string, schemaVersion: number, payload: object, meta: object, createdAt: number }[]} */
  const drafts = [];

  /** @type {{ committedId: number, id: string, projectId?: string, userId?: string, partition: string, type: string, schemaVersion: number, payload: object, meta: object, serverTs: number, createdAt?: number }[]} */
  const committed = [];

  /** @type {Map<string, { comparisonKey: string, committedEvent: { committedId: number, id: string, projectId?: string, userId?: string, partition: string, type: string, schemaVersion: number, payload: object, meta: object, serverTs: number, createdAt?: number } }>} */
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

  const normalizeCommittedMeta = (meta) =>
    normalizeMeta({
      clientTs:
        typeof meta?.clientTs === "number" && Number.isFinite(meta.clientTs)
          ? meta.clientTs
          : 0,
    });

  const normalizeCommittedEvent = (event) => ({
    ...event,
    payload: structuredClone(event.payload),
    meta: normalizeCommittedMeta(event.meta),
  });

  const toComparisonKey = (event) =>
    canonicalizeSubmitItem({
      partition: event.partition,
      projectId: event.projectId,
      userId: event.userId,
      type: event.type,
      schemaVersion: event.schemaVersion,
      payload: event.payload,
      meta: normalizeCommittedMeta(event.meta),
    });

  const upsertCommitted = (event) => {
    const normalizedEvent = normalizeCommittedEvent(event);
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

    insertDrafts: async (items) => {
      const seenIds = new Set();
      const nextDrafts = items.map(
        ({
          id,
          partition,
          projectId,
          userId,
          type,
          schemaVersion,
          payload,
          meta,
          createdAt,
        }) => {
          if (seenIds.has(id)) {
            throw new Error(`draft with id ${id} already exists`);
          }
          seenIds.add(id);
          const existing = drafts.find((entry) => entry.id === id);
          if (existing) {
            throw new Error(`draft with id ${id} already exists`);
          }

          return {
            draftClock: nextDraftClock,
            id,
            partition,
            projectId,
            userId,
            type,
            schemaVersion,
            payload: structuredClone(payload),
            meta: normalizeMeta(meta),
            createdAt,
          };
        },
      );

      for (const draft of nextDrafts) {
        drafts.push(draft);
        nextDraftClock += 1;
      }
    },

    insertDraft: async ({
      id,
      partition,
      projectId,
      userId,
      type,
      schemaVersion,
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
        partition,
        projectId,
        userId,
        type,
        schemaVersion,
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
          const committedEvent = normalizeCommittedEvent(
            buildCommittedEventFromDraft({
              draft,
              committedId: result.committedId,
              serverTs: result.serverTs,
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
      for (const event of events) {
        const committedEvent = normalizeCommittedEvent(event);
        const inserted = upsertCommitted(committedEvent);
        if (inserted) {
          await materializedViewRuntime.onCommittedEvent(committedEvent);
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
