import { canonicalizeSubmitItem } from "./canonicalize.js";
import {
  applyMaterializedViewReducer,
  cloneMaterializedViewValue,
  createMaterializedViewInitialState,
  normalizeMaterializedViewDefinitions,
} from "./materialized-view.js";

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
  /** @type {{ draftClock: number, id: string, clientId: string, partitions: string[], event: object, createdAt: number }[]} */
  const drafts = [];

  /** @type {{ committed_id: number, id: string, client_id: string, partitions: string[], event: object, status_updated_at: number }[]} */
  const committed = [];

  /** @type {Map<string, { canonical: string, committedEvent: { committed_id: number, id: string, client_id: string, partitions: string[], event: object, status_updated_at: number } }>} */
  const committedById = new Map();

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);
  /** @type {Map<string, Map<string, unknown>>} */
  const materializedStatesByView = new Map(
    materializedViewDefinitions.map((definition) => [
      definition.name,
      new Map(),
    ]),
  );
  const materializedDefinitionByName = new Map(
    materializedViewDefinitions.map((definition) => [
      definition.name,
      definition,
    ]),
  );

  let nextDraftClock = 1;
  let cursor = 0;

  const removeDraftById = (id) => {
    const index = drafts.findIndex((entry) => entry.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  const getMaterializedDefinition = (viewName) => {
    const definition = materializedDefinitionByName.get(viewName);
    if (!definition) {
      throw new Error(`unknown materialized view '${viewName}'`);
    }
    return definition;
  };

  const applyCommittedToMaterializedViews = (event) => {
    for (const definition of materializedViewDefinitions) {
      const byPartition = materializedStatesByView.get(definition.name);
      for (const partition of event.partitions) {
        const current = byPartition.has(partition)
          ? byPartition.get(partition)
          : createMaterializedViewInitialState(definition, partition);
        const next = applyMaterializedViewReducer(
          definition,
          current,
          event,
          partition,
        );
        byPartition.set(partition, next);
      }
    }
  };

  const upsertCommitted = (event) => {
    const existing = committedById.get(event.id);
    const canonical = canonicalizeSubmitItem({
      partitions: event.partitions,
      event: event.event,
    });
    if (existing) {
      if (
        existing.committedEvent.committed_id !== event.committed_id ||
        existing.committedEvent.client_id !== event.client_id ||
        existing.canonical !== canonical
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
      return false;
    }

    committedById.set(event.id, { canonical, committedEvent: event });
    committed.push(event);
    committed.sort((left, right) => left.committed_id - right.committed_id);
    applyCommittedToMaterializedViews(event);
    return true;
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

      if (nextCursor !== undefined) cursor = Math.max(cursor, nextCursor);
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      if (typeof partition !== "string" || partition.length === 0) {
        throw new Error("loadMaterializedView requires a non-empty partition");
      }
      const definition = getMaterializedDefinition(viewName);
      const byPartition = materializedStatesByView.get(definition.name);
      const state = byPartition.has(partition)
        ? byPartition.get(partition)
        : createMaterializedViewInitialState(definition, partition);
      return cloneMaterializedViewValue(state);
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
