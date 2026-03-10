import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";

/**
 * @param {number} [startCommittedId]
 */
export const createInMemorySyncStore = (startCommittedId = 0) => {
  /** @type {Map<string, { comparisonKey: string, committedEvent: { id: string, projectId?: string, userId?: string, partitions: string[], committedId: number, type: string, payload: object, meta: object, created: number } }>} */
  const byId = new Map();

  /** @type {{ id: string, projectId?: string, userId?: string, partitions: string[], committedId: number, type: string, payload: object, meta: object, created: number }[]} */
  const committed = [];

  let nextCommittedId = startCommittedId + 1;

  return {
    /**
     * @param {{ id: string, partitions: string[], projectId?: string, userId?: string, type: string, payload: object, meta: object, now: number }} input
     */
    commitOrGetExisting: async ({
      id,
      partitions,
      projectId,
      userId,
      type,
      payload,
      meta,
      now,
    }) => {
      const normalizedPartitions = normalizePartitionSet(partitions);
      const normalizedMeta = normalizeMeta(meta);
      const comparisonKey = canonicalizeSubmitItem({
        partitions: normalizedPartitions,
        projectId,
        userId,
        type,
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
        partitions: normalizedPartitions,
        committedId: nextCommittedId,
        type,
        payload: structuredClone(payload),
        meta: normalizedMeta,
        created: now,
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
     * @param {{ partitions: string[], sinceCommittedId: number, limit: number, syncToCommittedId?: number }} input
     */
    listCommittedSince: async ({
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      const normalizedPartitions = normalizePartitionSet(partitions);
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : Number.POSITIVE_INFINITY;

      const filtered = committed.filter(
        (event) =>
          event.committedId > sinceCommittedId &&
          event.committedId <= upperBound &&
          intersectsPartitions(normalizedPartitions, event.partitions),
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
     * @param {{ partitions: string[] }} input
     */
    getMaxCommittedIdForPartitions: async ({ partitions }) => {
      const normalizedPartitions = normalizePartitionSet(partitions);
      let maxCommittedId = 0;
      for (const event of committed) {
        if (!intersectsPartitions(normalizedPartitions, event.partitions)) {
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
