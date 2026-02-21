// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

import {
  applyMaterializedViewReducer,
  cloneMaterializedViewValue,
  createMaterializedViewInitialState,
  normalizeMaterializedViewDefinitions,
} from "./materialized-view.js";

const SCHEMA_VERSION = 2;
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 512;

const createTransaction = (db, fn) => {
  if (typeof db.transaction === "function") {
    return db.transaction(fn);
  }

  return (arg) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(arg);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort rollback
      }
      throw error;
    }
  };
};

const parseIntSafe = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
};

export const createSqliteClientStore = (
  db,
  {
    applyPragmas = true,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
    materializedViews,
    materializedBackfillChunkSize = DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE,
  } = {},
) => {
  let initialized = false;
  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);
  const materializedDefinitionByName = new Map(
    materializedViewDefinitions.map((definition) => [
      definition.name,
      definition,
    ]),
  );

  /** @type {null|ReturnType<typeof db.prepare>} */
  let loadCursorStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let saveCursorStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let insertDraftStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let listDraftsStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getDraftByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let deleteDraftByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let insertCommittedStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getCommittedByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getCommittedByCommittedIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let listCommittedAfterStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getMaterializedViewStateStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let upsertMaterializedViewStateStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let deleteMaterializedViewStateStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getMaterializedViewOffsetStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let upsertMaterializedViewOffsetStmt = null;

  /** @type {null|((arg: { result: object, fallbackClientId: string }) => void)} */
  let applySubmitResultTxn = null;
  /** @type {null|((arg: { events: object[], nextCursor?: number }) => void)} */
  let applyCommittedBatchTxn = null;
  /** @type {null|(() => void)} */
  let catchUpMaterializedViewsTxn = null;

  const runPragmas = () => {
    if (!applyPragmas) return;
    db.exec(`PRAGMA journal_mode=${journalMode};`);
    db.exec(`PRAGMA synchronous=${synchronous};`);
    if (Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0) {
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
    }
  };

  const getUserVersion = () => {
    const row = db.prepare("PRAGMA user_version").get();
    return parseIntSafe(row.user_version);
  };

  const setUserVersion = (version) => {
    db.exec(`PRAGMA user_version=${version};`);
  };

  const migrations = [
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_drafts (
          draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS committed_events (
          committed_id INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          status_updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS materialized_view_state (
          view_name TEXT NOT NULL,
          partition TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(view_name, partition)
        );

        CREATE TABLE IF NOT EXISTS materialized_view_offsets (
          view_name TEXT PRIMARY KEY,
          view_version TEXT NOT NULL,
          last_committed_id INTEGER NOT NULL
        );
      `);
    },
  ];

  const runMigrations = () => {
    let current = getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    for (let next = current + 1; next <= SCHEMA_VERSION; next += 1) {
      const migrate = migrations[next - 1];
      if (typeof migrate !== "function") {
        throw new Error(`Missing migration for schema version ${next}`);
      }

      const migrationTxn = createTransaction(db, () => {
        migrate();
        setUserVersion(next);
      });
      migrationTxn();
      current = next;
    }
  };

  const parseDraft = (row) => ({
    draftClock: row.draft_clock,
    id: row.id,
    clientId: row.client_id,
    partitions: JSON.parse(row.partitions),
    event: JSON.parse(row.event),
    createdAt: row.created_at,
  });

  const parseCommittedRow = (row) => ({
    committed_id: row.committed_id,
    id: row.id,
    client_id: row.client_id,
    partitions: JSON.parse(row.partitions),
    event: JSON.parse(row.event),
    status_updated_at: row.status_updated_at,
  });

  const encodeMaterializedValue = (value) =>
    JSON.stringify(value === undefined ? null : value);

  const assertCommittedInvariant = (event) => {
    const byId = getCommittedByIdStmt.get({ id: event.id });
    if (byId && byId.committed_id !== event.committed_id) {
      throw new Error(
        `committed event invariant violation for id ${event.id}: committed_id mismatch`,
      );
    }

    const byCommittedId = getCommittedByCommittedIdStmt.get({
      committed_id: event.committed_id,
    });
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committed_id ${event.committed_id}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = (nextCursor) => {
    const row = loadCursorStmt.get();
    const currentCursor = row ? parseIntSafe(row.value) : 0;
    const effectiveCursor = Math.max(currentCursor, nextCursor);
    saveCursorStmt.run({ value: String(effectiveCursor) });
  };

  const getMaterializedDefinition = (viewName) => {
    const definition = materializedDefinitionByName.get(viewName);
    if (!definition) {
      throw new Error(`unknown materialized view '${viewName}'`);
    }
    return definition;
  };

  const loadMaterializedPartitionState = (definition, partition) => {
    const row = getMaterializedViewStateStmt.get({
      view_name: definition.name,
      partition,
    });
    if (!row) {
      return createMaterializedViewInitialState(definition, partition);
    }
    return JSON.parse(row.value);
  };

  const saveMaterializedPartitionState = (
    definition,
    partition,
    value,
    updatedAt,
  ) => {
    upsertMaterializedViewStateStmt.run({
      view_name: definition.name,
      partition,
      value: encodeMaterializedValue(value),
      updated_at: updatedAt,
    });
  };

  const saveMaterializedOffsetMonotonic = (definition, nextCommittedId) => {
    const row = getMaterializedViewOffsetStmt.get({
      view_name: definition.name,
    });
    const currentOffset = row ? parseIntSafe(row.last_committed_id) : 0;
    const effectiveOffset = Math.max(currentOffset, nextCommittedId);
    upsertMaterializedViewOffsetStmt.run({
      view_name: definition.name,
      view_version: definition.version,
      last_committed_id: effectiveOffset,
    });
  };

  const applyCommittedToMaterializedViews = (committedEvent) => {
    if (materializedViewDefinitions.length === 0) return;
    for (const definition of materializedViewDefinitions) {
      for (const partition of committedEvent.partitions) {
        const current = loadMaterializedPartitionState(definition, partition);
        const next = applyMaterializedViewReducer(
          definition,
          current,
          committedEvent,
          partition,
        );
        saveMaterializedPartitionState(
          definition,
          partition,
          next,
          committedEvent.status_updated_at,
        );
      }
      saveMaterializedOffsetMonotonic(definition, committedEvent.committed_id);
    }
  };

  const resolveMaterializedStartOffset = (definition) => {
    const row = getMaterializedViewOffsetStmt.get({
      view_name: definition.name,
    });
    if (!row) {
      upsertMaterializedViewOffsetStmt.run({
        view_name: definition.name,
        view_version: definition.version,
        last_committed_id: 0,
      });
      return 0;
    }

    if (row.view_version !== definition.version) {
      deleteMaterializedViewStateStmt.run({ view_name: definition.name });
      upsertMaterializedViewOffsetStmt.run({
        view_name: definition.name,
        view_version: definition.version,
        last_committed_id: 0,
      });
      return 0;
    }

    return parseIntSafe(row.last_committed_id);
  };

  const prepareStatements = () => {
    loadCursorStmt = db.prepare(
      `SELECT value FROM app_state WHERE key = 'cursor_committed_id'`,
    );
    saveCursorStmt = db.prepare(`
      INSERT INTO app_state(key, value)
      VALUES('cursor_committed_id', @value)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);

    insertDraftStmt = db.prepare(`
      INSERT INTO local_drafts(id, client_id, partitions, event, created_at)
      VALUES(@id, @client_id, @partitions, @event, @created_at)
    `);
    listDraftsStmt = db.prepare(`
      SELECT draft_clock, id, client_id, partitions, event, created_at
      FROM local_drafts
      ORDER BY draft_clock ASC, id ASC
    `);
    getDraftByIdStmt = db.prepare(`
      SELECT draft_clock, id, client_id, partitions, event, created_at
      FROM local_drafts
      WHERE id = @id
    `);
    deleteDraftByIdStmt = db.prepare(`
      DELETE FROM local_drafts WHERE id = @id
    `);

    insertCommittedStmt = db.prepare(`
      INSERT OR IGNORE INTO committed_events(
        committed_id,
        id,
        client_id,
        partitions,
        event,
        status_updated_at
      ) VALUES (
        @committed_id,
        @id,
        @client_id,
        @partitions,
        @event,
        @status_updated_at
      )
    `);
    getCommittedByIdStmt = db.prepare(`
      SELECT committed_id, id, client_id, partitions, event, status_updated_at
      FROM committed_events
      WHERE id = @id
    `);
    getCommittedByCommittedIdStmt = db.prepare(`
      SELECT committed_id, id, client_id, partitions, event, status_updated_at
      FROM committed_events
      WHERE committed_id = @committed_id
    `);
    listCommittedAfterStmt = db.prepare(`
      SELECT committed_id, id, client_id, partitions, event, status_updated_at
      FROM committed_events
      WHERE committed_id > @since_committed_id
      ORDER BY committed_id ASC
      LIMIT @limit
    `);

    getMaterializedViewStateStmt = db.prepare(`
      SELECT value
      FROM materialized_view_state
      WHERE view_name = @view_name AND partition = @partition
    `);
    upsertMaterializedViewStateStmt = db.prepare(`
      INSERT INTO materialized_view_state(
        view_name,
        partition,
        value,
        updated_at
      ) VALUES (
        @view_name,
        @partition,
        @value,
        @updated_at
      )
      ON CONFLICT(view_name, partition) DO UPDATE
      SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    deleteMaterializedViewStateStmt = db.prepare(`
      DELETE FROM materialized_view_state
      WHERE view_name = @view_name
    `);
    getMaterializedViewOffsetStmt = db.prepare(`
      SELECT view_name, view_version, last_committed_id
      FROM materialized_view_offsets
      WHERE view_name = @view_name
    `);
    upsertMaterializedViewOffsetStmt = db.prepare(`
      INSERT INTO materialized_view_offsets(
        view_name,
        view_version,
        last_committed_id
      ) VALUES (
        @view_name,
        @view_version,
        @last_committed_id
      )
      ON CONFLICT(view_name) DO UPDATE
      SET
        view_version = excluded.view_version,
        last_committed_id = excluded.last_committed_id
    `);

    applySubmitResultTxn = createTransaction(
      db,
      ({ result, fallbackClientId }) => {
        if (result.status === "committed") {
          const draft = getDraftByIdStmt.get({ id: result.id });

          if (draft) {
            const insertResult = insertCommittedStmt.run({
              committed_id: result.committed_id,
              id: result.id,
              client_id: draft.client_id || fallbackClientId,
              partitions: draft.partitions,
              event: draft.event,
              status_updated_at: result.status_updated_at,
            });
            if (insertResult.changes === 0) {
              assertCommittedInvariant({
                committed_id: result.committed_id,
                id: result.id,
              });
            } else {
              applyCommittedToMaterializedViews({
                committed_id: result.committed_id,
                id: result.id,
                client_id: draft.client_id || fallbackClientId,
                partitions: JSON.parse(draft.partitions),
                event: JSON.parse(draft.event),
                status_updated_at: result.status_updated_at,
              });
            }
          }
        }

        deleteDraftByIdStmt.run({ id: result.id });
      },
    );

    applyCommittedBatchTxn = createTransaction(db, ({ events, nextCursor }) => {
      for (const event of events) {
        const insertResult = insertCommittedStmt.run({
          committed_id: event.committed_id,
          id: event.id,
          client_id: event.client_id,
          partitions: JSON.stringify(event.partitions),
          event: JSON.stringify(event.event),
          status_updated_at: event.status_updated_at,
        });

        if (insertResult.changes === 0) {
          assertCommittedInvariant(event);
        } else {
          applyCommittedToMaterializedViews(event);
        }

        deleteDraftByIdStmt.run({ id: event.id });
      }

      if (nextCursor !== undefined) {
        saveCursorMonotonic(nextCursor);
      }
    });

    catchUpMaterializedViewsTxn = createTransaction(db, () => {
      if (materializedViewDefinitions.length === 0) return;

      const chunkSize =
        Number.isInteger(materializedBackfillChunkSize) &&
        materializedBackfillChunkSize > 0
          ? materializedBackfillChunkSize
          : DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE;

      for (const definition of materializedViewDefinitions) {
        let cursor = resolveMaterializedStartOffset(definition);

        while (true) {
          const rows = listCommittedAfterStmt.all({
            since_committed_id: cursor,
            limit: chunkSize,
          });
          if (rows.length === 0) break;

          for (const row of rows) {
            const committedEvent = parseCommittedRow(row);
            for (const partition of committedEvent.partitions) {
              const current = loadMaterializedPartitionState(
                definition,
                partition,
              );
              const next = applyMaterializedViewReducer(
                definition,
                current,
                committedEvent,
                partition,
              );
              saveMaterializedPartitionState(
                definition,
                partition,
                next,
                committedEvent.status_updated_at,
              );
            }
            cursor = committedEvent.committed_id;
          }

          if (rows.length < chunkSize) break;
        }

        upsertMaterializedViewOffsetStmt.run({
          view_name: definition.name,
          view_version: definition.version,
          last_committed_id: cursor,
        });
      }
    });
  };

  const ensureInitialized = () => {
    if (initialized) return;
    runPragmas();
    runMigrations();
    prepareStatements();
    catchUpMaterializedViewsTxn();
    initialized = true;
  };

  return {
    init: async () => {
      ensureInitialized();
    },

    loadCursor: async () => {
      ensureInitialized();
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      ensureInitialized();
      insertDraftStmt.run({
        id,
        client_id: clientId,
        partitions: JSON.stringify(partitions),
        event: JSON.stringify(event),
        created_at: createdAt,
      });
    },

    loadDraftsOrdered: async () => {
      ensureInitialized();
      return listDraftsStmt.all().map(parseDraft);
    },

    applySubmitResult: async ({ result, fallbackClientId }) => {
      ensureInitialized();
      applySubmitResultTxn({ result, fallbackClientId });
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      ensureInitialized();
      applyCommittedBatchTxn({ events, nextCursor });
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      ensureInitialized();
      if (typeof partition !== "string" || partition.length === 0) {
        throw new Error("loadMaterializedView requires a non-empty partition");
      }
      const definition = getMaterializedDefinition(viewName);
      const state = loadMaterializedPartitionState(definition, partition);
      return cloneMaterializedViewValue(state);
    },
  };
};

// Backwards-compatible alias used by examples/docs.
export const createSqliteStore = createSqliteClientStore;
