import { canonicalizeSubmitItem } from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";

/**
 * @param {number} [startCommittedId]
 */
export const createInMemorySyncStore = (startCommittedId = 0) => {
  /** @type {Map<string, { comparisonKey: string, committedEvent: { id: string, projectId?: string, userId?: string, partition: string, committedId: number, type: string, schemaVersion: number, payload: object, meta: object, serverTs: number } }>} */
  const byId = new Map();

  /** @type {{ id: string, projectId?: string, userId?: string, partition: string, committedId: number, type: string, schemaVersion: number, payload: object, meta: object, serverTs: number }[]} */
  const committed = [];

  let nextCommittedId = startCommittedId + 1;

  return {
    /**
     * @param {{ id: string, partition: string, projectId?: string, userId?: string, type: string, schemaVersion: number, payload: object, meta: object, now: number }} input
     */
    commitOrGetExisting: async ({
      id,
      partition,
      projectId,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      now,
    }) => {
      const normalizedMeta = normalizeMeta(meta);
      const comparisonKey = canonicalizeSubmitItem({
        partition,
        projectId,
        userId,
        type,
        schemaVersion,
        payload,
        meta: normalizedMeta,
      });

      const existing = byId.get(id);
      if (existing) {
        if (existing.comparisonKey !== comparisonKey) {
          const error = new Error("same id submitted with different payload");
          // @ts-ignore
          error.code = "validation_failed";
          throw error;
        }

        return {
          deduped: true,
          committedEvent: existing.committedEvent,
        };
      }

      const committedEvent = {
        id,
        projectId,
        userId,
        partition,
        committedId: nextCommittedId,
        type,
        schemaVersion,
        payload: structuredClone(payload),
        meta: normalizedMeta,
        serverTs: now,
      };
      nextCommittedId += 1;

      byId.set(id, { comparisonKey, committedEvent });
      committed.push(committedEvent);

      return {
        deduped: false,
        committedEvent,
      };
    },

    /**
     * @param {{ projectId: string, sinceCommittedId: number, limit: number, syncToCommittedId?: number }} input
     */
    listCommittedSince: async ({
      projectId,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : Number.POSITIVE_INFINITY;

      const filtered = committed.filter(
        (event) =>
          event.projectId === projectId &&
          event.committedId > sinceCommittedId &&
          event.committedId <= upperBound,
      );

      const events = filtered.slice(0, limit);
      const hasMore = filtered.length > events.length;
      const nextSinceCommittedId =
        events.length > 0
          ? events[events.length - 1].committedId
          : sinceCommittedId;

      return {
        events,
        hasMore,
        nextSinceCommittedId,
      };
    },

    getMaxCommittedId: async () => {
      if (committed.length === 0) return 0;
      return committed[committed.length - 1].committedId;
    },

    /**
     * @param {{ projectId: string }} input
     */
    getMaxCommittedIdForProject: async ({ projectId }) => {
      let maxCommittedId = 0;
      for (const event of committed) {
        if (event.projectId !== projectId) {
          continue;
        }
        if (event.committedId > maxCommittedId) {
          maxCommittedId = event.committedId;
        }
      }
      return maxCommittedId;
    },

    _debug: {
      getCommitted: () => [...committed],
      getById: () => new Map(byId),
    },
  };
};
