import {
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  getProjectPartitions,
  partitionSetBelongsToProject,
} from "./partition-scope.js";
import {
  getStoredCommittedId,
  toStoredCommitted,
  toStoredComparisonKey,
} from "./stored-event.js";

/**
 * @param {number} [startCommittedId]
 */
export const createInMemorySyncStore = (startCommittedId = 0) => {
  /** @type {Map<string, { comparisonKey: string, committedEvent: object }>} */
  const byId = new Map();

  /** @type {object[]} */
  const committed = [];

  let nextCommittedId = startCommittedId + 1;

  return {
    /**
     * @param {{ id: string, clientId?: string, partitions?: string[], event?: object, partition?: string, projectId?: string, type?: string, schemaVersion?: number, payload?: object, meta?: object, now: number }} input
     */
    commitOrGetExisting: async ({
      id,
      partition,
      projectId,
      partitions,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      event,
      now,
    }) => {
      const committedEvent = toStoredCommitted({
        id,
        partition,
        projectId,
        partitions,
        userId,
        type,
        schemaVersion,
        payload,
        meta,
        event,
        committed_id: nextCommittedId,
        status_updated_at: now,
      });
      const comparisonKey = toStoredComparisonKey(committedEvent);

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

      nextCommittedId += 1;

      byId.set(id, { comparisonKey, committedEvent });
      committed.push(committedEvent);

      return {
        deduped: false,
        committedEvent,
      };
    },

    /**
     * @param {{ projectId: string, partitions?: string[], sinceCommittedId: number, limit: number, syncToCommittedId?: number }} input
     */
    listCommittedSince: async ({
      projectId,
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : Number.POSITIVE_INFINITY;
      const requestedPartitions = normalizePartitionSet(
        partitions || getProjectPartitions(projectId),
      );

      const filtered = committed.filter(
        (event) =>
          intersectsPartitions(requestedPartitions, event.partitions) &&
          partitionSetBelongsToProject(event.partitions, projectId) &&
          getStoredCommittedId(event) > sinceCommittedId &&
          getStoredCommittedId(event) <= upperBound,
      );

      const events = filtered.slice(0, limit);
      const hasMore = filtered.length > events.length;
      const nextSinceCommittedId =
        events.length > 0
          ? getStoredCommittedId(events[events.length - 1])
          : sinceCommittedId;

      return {
        events,
        hasMore,
        nextSinceCommittedId,
      };
    },

    getMaxCommittedId: async () => {
      if (committed.length === 0) return 0;
      return getStoredCommittedId(committed[committed.length - 1]);
    },

    /**
     * @param {{ projectId: string }} input
     */
    getMaxCommittedIdForProject: async ({ projectId }) => {
      let maxCommittedId = 0;
      const requestedPartitions = normalizePartitionSet(
        getProjectPartitions(projectId),
      );
      for (const event of committed) {
        if (
          !intersectsPartitions(requestedPartitions, event.partitions) ||
          !partitionSetBelongsToProject(event.partitions, projectId)
        ) {
          continue;
        }
        if (getStoredCommittedId(event) > maxCommittedId) {
          maxCommittedId = getStoredCommittedId(event);
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
