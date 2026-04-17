import { canonicalizeSubmitItem } from "./canonicalize.js";
import {
  buildCommittedEventFromDraft,
  normalizeClientTs,
} from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
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
  /** @type {{ draftClock: number, id: string, partition: string, projectId?: string, userId?: string, type: string, schemaVersion: number, payload: object, clientTs: number, createdAt: number }[]} */
  const drafts = [];

  /** @type {{ committedId: number, id: string, projectId?: string, userId?: string, partition: string, type: string, schemaVersion: number, payload: object, clientTs: number, serverTs: number, createdAt?: number }[]} */
  const committed = [];

  /** @type {Map<string, { comparisonKey: string, committedEvent: { committedId: number, id: string, projectId?: string, userId?: string, partition: string, type: string, schemaVersion: number, payload: object, clientTs: number, serverTs: number, createdAt?: number } }>} */
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
      .filter((event) => event.committedId > sinceCommittedId)
      .slice(0, limit);

  const removeDraftById = (id) => {
    const index = drafts.findIndex((entry) => entry.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  const normalizeCommittedEvent = (event) => ({
    ...event,
    payload: structuredClone(event.payload),
    clientTs: normalizeClientTs(event.clientTs, {
      defaultClientTs: event.meta?.clientTs,
    }),
  });

  const toComparisonKey = (event) =>
    canonicalizeSubmitItem({
      partition: event.partition,
      type: event.type,
      schemaVersion: event.schemaVersion,
      payload: event.payload,
      clientTs: normalizeClientTs(event.clientTs),
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
      const nextDrafts = items.map(
        ({
          id,
          partition,
          projectId,
          userId,
          type,
          schemaVersion,
          payload,
          clientTs,
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
            clientTs: normalizeClientTs(clientTs, {
              defaultClientTs: meta?.clientTs,
            }),
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
      clientTs,
      meta,
      createdAt,
    }) => {
      ensureOpen();
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
        clientTs: normalizeClientTs(clientTs, {
          defaultClientTs: meta?.clientTs,
        }),
        createdAt,
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
      ensureOpen();
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
