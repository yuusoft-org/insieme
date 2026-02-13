const sortDrafts = (left, right) => {
  if (left.draftClock !== right.draftClock) {
    return left.draftClock - right.draftClock;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/**
 * In-memory client store implementing the simplified client storage interface.
 */
export const createInMemoryClientStore = () => {
  /** @type {{ draftClock: number, id: string, clientId: string, partitions: string[], event: object, createdAt: number }[]} */
  const drafts = [];

  /** @type {{ committed_id: number, id: string, client_id: string, partitions: string[], event: object, status_updated_at: number }[]} */
  const committed = [];

  /** @type {Map<string, { committed_id: number, id: string, client_id: string, partitions: string[], event: object, status_updated_at: number }>} */
  const committedById = new Map();

  let nextDraftClock = 1;
  let cursor = 0;

  const removeDraftById = (id) => {
    const index = drafts.findIndex((entry) => entry.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  const upsertCommitted = (event) => {
    const existing = committedById.get(event.id);
    if (existing) return;

    committedById.set(event.id, event);
    committed.push(event);
    committed.sort((left, right) => left.committed_id - right.committed_id);
  };

  return {
    init: async () => {},

    loadCursor: async () => cursor,

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      const existing = drafts.find((entry) => entry.id === id);
      if (existing) {
        throw new Error(`draft with id ${id} already exists`);
      }

      drafts.push({
        draftClock: nextDraftClock,
        id,
        clientId,
        partitions: [...partitions],
        event,
        createdAt,
      });
      nextDraftClock += 1;
    },

    loadDraftsOrdered: async () => [...drafts].sort(sortDrafts),

    applySubmitResult: async ({ result, fallbackClientId }) => {
      if (result.status === "committed") {
        const draft = drafts.find((entry) => entry.id === result.id);
        if (draft) {
          upsertCommitted({
            committed_id: result.committed_id,
            id: draft.id,
            client_id: draft.clientId || fallbackClientId,
            partitions: [...draft.partitions],
            event: draft.event,
            status_updated_at: result.status_updated_at,
          });
        }
      }

      removeDraftById(result.id);
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      for (const event of events) {
        upsertCommitted(event);
        removeDraftById(event.id);
      }

      if (nextCursor !== undefined) cursor = nextCursor;
    },

    _debug: {
      getDrafts: () => [...drafts].sort(sortDrafts),
      getCommitted: () => [...committed],
      getCursor: () => cursor,
    },
  };
};
