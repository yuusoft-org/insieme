import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";

/**
 * @param {number} [startCommittedId]
 */
export const createInMemorySyncStore = (startCommittedId = 0) => {
  /** @type {Map<string, { canonical: string, committedEvent: { id: string, client_id: string, partitions: string[], committed_id: number, event: object, status_updated_at: number } }>} */
  const byId = new Map();

  /** @type {{ id: string, client_id: string, partitions: string[], committed_id: number, event: object, status_updated_at: number }[]} */
  const committed = [];

  let nextCommittedId = startCommittedId + 1;

  return {
    /**
     * @param {{ id: string, clientId: string, partitions: string[], event: object, now: number }} input
     */
    commitOrGetExisting: async ({ id, clientId, partitions, event, now }) => {
      const normalizedPartitions = normalizePartitionSet(partitions);
      const canonical = canonicalizeSubmitItem({
        partitions: normalizedPartitions,
        event,
      });

      const existing = byId.get(id);
      if (existing) {
        if (existing.canonical !== canonical) {
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
        client_id: clientId,
        partitions: normalizedPartitions,
        committed_id: nextCommittedId,
        event,
        status_updated_at: now,
      };
      nextCommittedId += 1;

      byId.set(id, { canonical, committedEvent });
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
          event.committed_id > sinceCommittedId &&
          event.committed_id <= upperBound &&
          intersectsPartitions(normalizedPartitions, event.partitions),
      );

      const events = filtered.slice(0, limit);
      const hasMore = filtered.length > events.length;
      const nextSinceCommittedId =
        events.length > 0
          ? events[events.length - 1].committed_id
          : sinceCommittedId;

      return {
        events,
        hasMore,
        nextSinceCommittedId,
      };
    },

    getMaxCommittedId: async () => {
      if (committed.length === 0) return 0;
      return committed[committed.length - 1].committed_id;
    },

    _debug: {
      getCommitted: () => [...committed],
      getById: () => new Map(byId),
    },
  };
};
