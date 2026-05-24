// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

import { normalizePartitionSet } from "./canonicalize.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { deserializePayload } from "./payload-codec.js";
import { buildProjectScopePartition } from "./partition-scope.js";
import {
  buildStoredCommittedFromDraft,
  getStoredCommittedId,
  parseStoredEvent,
  parseStoredPartitions,
  toStoredCommitted,
  toStoredComparisonKey,
  toStoredDraft,
  withStoredCommittedAliases,
  withStoredDraftAliases,
} from "./stored-event.js";
import { throwIfClosed } from "./store-errors.js";

const SCHEMA_VERSION = 7;
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

const toComparisonKey = (event) => toStoredComparisonKey(event);

const tableHasColumn = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

const tableExists = (db, tableName) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) !== undefined;

const hasCompatibleClientSchema = (db) => {
  const hasDraftClientId = tableHasColumn(db, "local_drafts", "client_id");
  const hasDraftPartitions = tableHasColumn(db, "local_drafts", "partitions");
  const hasDraftEvent = tableHasColumn(db, "local_drafts", "event");
  const hasCommittedClientId = tableHasColumn(
    db,
    "committed_events",
    "client_id",
  );
  const hasCommittedPartitions = tableHasColumn(
    db,
    "committed_events",
    "partitions",
  );
  const hasCommittedEvent = tableHasColumn(db, "committed_events", "event");
  const hasCommittedStatusUpdatedAt = tableHasColumn(
    db,
    "committed_events",
    "status_updated_at",
  );
  const draftEventType = getTableColumnType(db, "local_drafts", "event");
  const committedEventType = getTableColumnType(db, "committed_events", "event");
  return (
    hasDraftClientId &&
    hasDraftPartitions &&
    hasDraftEvent &&
    hasCommittedClientId &&
    hasCommittedPartitions &&
    hasCommittedEvent &&
    hasCommittedStatusUpdatedAt &&
    draftEventType === "TEXT" &&
    committedEventType === "TEXT"
  );
};

const hasLegacyFlatClientSchema = (db) =>
  tableHasColumn(db, "local_drafts", "partition") &&
  tableHasColumn(db, "local_drafts", "type") &&
  tableHasColumn(db, "local_drafts", "schema_version") &&
  tableHasColumn(db, "local_drafts", "payload") &&
  tableHasColumn(db, "committed_events", "partition") &&
  tableHasColumn(db, "committed_events", "type") &&
  tableHasColumn(db, "committed_events", "schema_version") &&
  tableHasColumn(db, "committed_events", "payload") &&
  tableHasColumn(db, "committed_events", "server_ts");

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
  let closed = false;
  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

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
  let getLatestCommittedIdStmt = null;
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

  /** @type {null|((arg: { result: object }) => object|undefined)} */
  let applySubmitResultTxn = null;
  /** @type {null|((arg: { events: object[], nextCursor?: number }) => object[])} */
  let applyCommittedBatchTxn = null;
  /** @type {null|((arg: { items: object[] }) => void)} */
  let insertDraftsTxn = null;
  let materializedViewRuntime;

  const ensureOpen = () => {
    throwIfClosed(closed, "sqlite client store", "client_store_closed");
  };

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

  const createSchema = () => {
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
    createMaterializedSchema();
  };

  const createMaterializedSchema = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        view_version TEXT,
        last_committed_id INTEGER,
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
    if (!tableHasColumn(db, "materialized_view_state", "view_version")) {
      db.exec("ALTER TABLE materialized_view_state ADD COLUMN view_version TEXT;");
    }
    if (!tableHasColumn(db, "materialized_view_state", "last_committed_id")) {
      db.exec(
        "ALTER TABLE materialized_view_state ADD COLUMN last_committed_id INTEGER;",
      );
    }
  };

  const validateSchema = () => {
    if (!hasCompatibleClientSchema(db)) {
      throw new Error("Client store schema is incompatible; reset required");
    }
  };

  const migrateLegacyFlatSchema = () => {
    db.exec(`
      ALTER TABLE local_drafts RENAME TO local_drafts_legacy_v6;
      ALTER TABLE committed_events RENAME TO committed_events_legacy_v6;
    `);
    createSchema();

    const draftRows = db
      .prepare(`
        SELECT
          draft_clock,
          id,
          partition,
          type,
          schema_version,
          payload,
          client_ts,
          created_at
        FROM local_drafts_legacy_v6
        ORDER BY draft_clock ASC, id ASC
      `)
      .all();
    const committedRows = db
      .prepare(`
        SELECT
          committed_id,
          id,
          project_id,
          user_id,
          partition,
          type,
          schema_version,
          payload,
          client_ts,
          server_ts,
          created_at
        FROM committed_events_legacy_v6
        ORDER BY committed_id ASC
      `)
      .all();
    const insertDraft = db.prepare(`
      INSERT INTO local_drafts(
        draft_clock,
        id,
        client_id,
        partitions,
        event,
        created_at
      ) VALUES (
        @draft_clock,
        @id,
        @client_id,
        @partitions,
        @event,
        @created_at
      )
    `);
    const insertCommitted = db.prepare(`
      INSERT INTO committed_events(
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

    for (const row of draftRows) {
      const draft = toStoredDraft({
        id: row.id,
        clientId: "",
        partition: row.partition || undefined,
        partitions: normalizePartitionSet([row.partition || undefined]),
        type: row.type,
        schemaVersion: parseIntSafe(row.schema_version),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts) },
        createdAt: parseIntSafe(row.created_at),
      });
      insertDraft.run({
        draft_clock: parseIntSafe(row.draft_clock),
        id: draft.id,
        client_id: draft.clientId || "",
        partitions: JSON.stringify(draft.partitions),
        event: JSON.stringify(draft.event),
        created_at: draft.createdAt,
      });
    }

    for (const row of committedRows) {
      const projectId = row.project_id || undefined;
      const partition = row.partition || undefined;
      const statusUpdatedAt = parseIntSafe(row.server_ts) || parseIntSafe(row.created_at);
      const committed = toStoredCommitted({
        committed_id: parseIntSafe(row.committed_id),
        id: row.id,
        clientId: "",
        projectId,
        userId: row.user_id || undefined,
        partition,
        partitions: normalizePartitionSet([
          projectId,
          projectId ? buildProjectScopePartition(projectId) : undefined,
          partition,
        ]),
        type: row.type,
        schemaVersion: parseIntSafe(row.schema_version),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts) },
        status_updated_at: statusUpdatedAt,
        serverTs: statusUpdatedAt,
      });
      insertCommitted.run({
        committed_id: committed.committed_id,
        id: committed.id,
        client_id: committed.client_id || "",
        partitions: JSON.stringify(committed.partitions),
        event: JSON.stringify(committed.event),
        status_updated_at: committed.status_updated_at,
      });
    }

    db.exec(`
      DROP TABLE local_drafts_legacy_v6;
      DROP TABLE committed_events_legacy_v6;
    `);
    validateSchema();
  };

  const initializeSchema = () => {
    const current = getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    const hasClientTables =
      tableExists(db, "local_drafts") && tableExists(db, "committed_events");
    if (current === 0 && !hasClientTables) {
      const initializeTxn = createTransaction(db, () => {
        createSchema();
        validateSchema();
        setUserVersion(SCHEMA_VERSION);
      });
      initializeTxn();
      return;
    }

    if (hasClientTables && hasCompatibleClientSchema(db)) {
      createMaterializedSchema();
      validateSchema();
      if (current !== SCHEMA_VERSION) {
        setUserVersion(SCHEMA_VERSION);
      }
      return;
    }

    if (hasClientTables && hasLegacyFlatClientSchema(db)) {
      const migrationTxn = createTransaction(db, () => {
        migrateLegacyFlatSchema();
        setUserVersion(SCHEMA_VERSION);
      });
      migrationTxn();
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Client store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    createMaterializedSchema();
    validateSchema();
  };

  const parseDraft = (row) => {
    return withStoredDraftAliases({
      draftClock: row.draft_clock,
      id: row.id,
      clientId: row.client_id,
      partitions: parseStoredPartitions(row.partitions),
      event: parseStoredEvent(row.event),
      createdAt: row.created_at,
    });
  };

  const parseCommittedRow = (row) => withStoredCommittedAliases({
    committed_id: row.committed_id,
    id: row.id,
    client_id: row.client_id,
    partitions: parseStoredPartitions(row.partitions),
    event: parseStoredEvent(row.event),
    status_updated_at: row.status_updated_at,
  });

  const encodeMaterializedValue = (value) =>
    JSON.stringify(value === undefined ? null : value);

  const assertCommittedInvariant = (event) => {
    const byId = getCommittedByIdStmt.get({ id: event.id });
    if (byId) {
      const parsedById = parseCommittedRow(byId);
      if (
        parsedById.committed_id !== getStoredCommittedId(event) ||
        toComparisonKey(parsedById) !== toComparisonKey(event)
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
    }

    const byCommittedId = getCommittedByCommittedIdStmt.get({
      committed_id: getStoredCommittedId(event),
    });
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${getStoredCommittedId(event)}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = (nextCursor) => {
    const row = loadCursorStmt.get();
    const currentCursor = row ? parseIntSafe(row.value) : 0;
    const effectiveCursor = Math.max(currentCursor, nextCursor);
    saveCursorStmt.run({ value: String(effectiveCursor) });
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
      INSERT INTO local_drafts(
        id,
        client_id,
        partitions,
        event,
        created_at
      ) VALUES(
        @id,
        @client_id,
        @partitions,
        @event,
        @created_at
      )
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
    getLatestCommittedIdStmt = db.prepare(`
      SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
      FROM committed_events
    `);

    getMaterializedViewStateStmt = db.prepare(`
      SELECT value, updated_at, view_version, last_committed_id
      FROM materialized_view_state
      WHERE view_name = @view_name AND partition = @partition
    `);
    upsertMaterializedViewStateStmt = db.prepare(`
      INSERT INTO materialized_view_state(
        view_name,
        partition,
        view_version,
        last_committed_id,
        value,
        updated_at
      ) VALUES (
        @view_name,
        @partition,
        @view_version,
        @last_committed_id,
        @value,
        @updated_at
      )
      ON CONFLICT(view_name, partition) DO UPDATE
      SET
        view_version = excluded.view_version,
        last_committed_id = excluded.last_committed_id,
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    deleteMaterializedViewStateStmt = db.prepare(`
      DELETE FROM materialized_view_state
      WHERE view_name = @view_name AND partition = @partition
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

    insertDraftsTxn = createTransaction(db, ({ items }) => {
      for (const item of items) {
        const draft = toStoredDraft(item);
        insertDraftStmt.run({
          id: draft.id,
          client_id: draft.clientId || "unknown",
          partitions: JSON.stringify(draft.partitions),
          event: JSON.stringify(draft.event),
          created_at: draft.createdAt,
        });
      }
    });

    applySubmitResultTxn = createTransaction(db, ({ result }) => {
      let committedEvent;

      if (result.status === "committed") {
        const draft = getDraftByIdStmt.get({ id: result.id });

        if (draft) {
          const parsedDraft = parseDraft(draft);
          const nextCommittedEvent = buildStoredCommittedFromDraft({
            draft: parsedDraft,
            result,
          });
          const insertResult = insertCommittedStmt.run({
            committed_id: nextCommittedEvent.committed_id,
            id: nextCommittedEvent.id,
            client_id: nextCommittedEvent.client_id || "unknown",
            partitions: JSON.stringify(nextCommittedEvent.partitions),
            event: JSON.stringify(nextCommittedEvent.event),
            status_updated_at: nextCommittedEvent.status_updated_at,
          });
          if (insertResult.changes === 0) {
            assertCommittedInvariant(nextCommittedEvent);
          } else {
            committedEvent = nextCommittedEvent;
          }
        }

        deleteDraftByIdStmt.run({ id: result.id });
        return committedEvent;
      }

      if (result.status === "rejected") {
        deleteDraftByIdStmt.run({ id: result.id });
      }
      return committedEvent;
    });

    applyCommittedBatchTxn = createTransaction(db, ({ events, nextCursor }) => {
      const insertedEvents = [];
      for (const event of events) {
        const committedRecord = toStoredCommitted(event);
        const insertResult = insertCommittedStmt.run({
          committed_id: committedRecord.committed_id,
          id: committedRecord.id,
          client_id: committedRecord.client_id || "unknown",
          partitions: JSON.stringify(committedRecord.partitions),
          event: JSON.stringify(committedRecord.event),
          status_updated_at: committedRecord.status_updated_at,
        });

        if (insertResult.changes === 0) {
          assertCommittedInvariant(committedRecord);
        } else {
          insertedEvents.push(committedRecord);
        }

        deleteDraftByIdStmt.run({ id: event.id });
      }

      if (nextCursor !== undefined) {
        saveCursorMonotonic(nextCursor);
      }

      return insertedEvents;
    });
  };

  const createRuntime = () =>
    createMaterializedViewRuntime({
      definitions: materializedViewDefinitions,
      chunkSize: materializedBackfillChunkSize,
      getLatestCommittedId: async () => {
        const row = getLatestCommittedIdStmt.get();
        return row ? parseIntSafe(row.max_committed_id) : 0;
      },
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        listCommittedAfterStmt
          .all({
            since_committed_id: sinceCommittedId,
            limit,
          })
          .map(parseCommittedRow),
      loadCheckpoint: async ({ viewName, partition }) => {
        const row = getMaterializedViewStateStmt.get({
          view_name: viewName,
          partition,
        });
        if (!row) return undefined;
        const offset = getMaterializedViewOffsetStmt.get({
          view_name: viewName,
        });
        if (row.last_committed_id === null || row.last_committed_id === undefined) {
          return undefined;
        }
        return {
          viewVersion: row.view_version ?? offset?.view_version,
          lastCommittedId: parseIntSafe(row.last_committed_id),
          value: JSON.parse(row.value),
          updatedAt: parseIntSafe(row.updated_at),
        };
      },
      saveCheckpoint: async ({
        viewName,
        viewVersion,
        partition,
        value,
        lastCommittedId,
        updatedAt,
      }) => {
        upsertMaterializedViewStateStmt.run({
          view_name: viewName,
          partition,
          view_version: viewVersion,
          last_committed_id: lastCommittedId,
          value: encodeMaterializedValue(value),
          updated_at: updatedAt,
        });
        upsertMaterializedViewOffsetStmt.run({
          view_name: viewName,
          view_version: viewVersion,
          last_committed_id: lastCommittedId,
        });
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        deleteMaterializedViewStateStmt.run({
          view_name: viewName,
          partition,
        });
      },
    });

  const ensureInitialized = () => {
    ensureOpen();
    if (initialized) return;
    runPragmas();
    initializeSchema();
    prepareStatements();
    materializedViewRuntime = createRuntime();
    initialized = true;
  };

  return {
    init: async () => {
      ensureInitialized();
    },

    close: async () => {
      if (closed) return;
      closed = true;
      if (materializedViewRuntime) {
        await materializedViewRuntime.flushMaterializedViews();
        await materializedViewRuntime.close();
      }
      if (typeof db.close === "function") {
        db.close();
      }
    },

    loadCursor: async () => {
      ensureInitialized();
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    getCursor: async () => {
      ensureInitialized();
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    insertDrafts: async (items) => {
      ensureInitialized();
      insertDraftsTxn({ items });
    },

    insertDraft: async ({
      id,
      clientId,
      projectId,
      userId,
      partition,
      type,
      schemaVersion,
      payload,
      clientTs,
      meta,
      payloadCompression,
      createdAt,
    }) => {
      ensureInitialized();
      const draft = toStoredDraft({
        id,
        clientId,
        projectId,
        userId,
        partition,
        type,
        schemaVersion,
        payload,
        clientTs,
        meta,
        payloadCompression,
        createdAt,
      });
      insertDraftStmt.run({
        id: draft.id,
        client_id: draft.clientId || "unknown",
        partitions: JSON.stringify(draft.partitions),
        event: JSON.stringify(draft.event),
        created_at: draft.createdAt,
      });
    },

    loadDraftsOrdered: async () => {
      ensureInitialized();
      return listDraftsStmt.all().map(parseDraft);
    },

    listDraftsOrdered: async () => {
      ensureInitialized();
      return listDraftsStmt.all().map(parseDraft);
    },

    applySubmitResult: async ({ result }) => {
      ensureInitialized();
      const committedEvent = applySubmitResultTxn({ result });
      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      ensureInitialized();
      const insertedEvents = applyCommittedBatchTxn({ events, nextCursor });
      for (const event of insertedEvents) {
        await materializedViewRuntime.onCommittedEvent(event);
      }
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      ensureInitialized();
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
      ensureInitialized();
      return materializedViewRuntime.subscribeMaterializedView({
        viewName,
        partition,
        onChange,
        emitCurrent,
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      ensureInitialized();
      await materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      ensureInitialized();
      await materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      });
    },

    flushMaterializedViews: async () => {
      ensureInitialized();
      await materializedViewRuntime.flushMaterializedViews();
    },

    listCommitted: async () => {
      ensureInitialized();
      return listCommittedAfterStmt
        .all({
          since_committed_id: 0,
          limit: Number.MAX_SAFE_INTEGER,
        })
        .map(parseCommittedRow);
    },

    listCommittedAfter: async ({
      sinceCommittedId = 0,
      limit = Number.MAX_SAFE_INTEGER,
    } = {}) => {
      ensureInitialized();
      return listCommittedAfterStmt
        .all({
          since_committed_id: sinceCommittedId,
          limit,
        })
        .map(parseCommittedRow);
    },

    _debug: {
      getDrafts: async () => {
        ensureInitialized();
        return listDraftsStmt.all().map(parseDraft);
      },
      getCommitted: async () => {
        ensureInitialized();
        return listCommittedAfterStmt
          .all({
            since_committed_id: 0,
            limit: Number.MAX_SAFE_INTEGER,
          })
          .map(parseCommittedRow);
      },
      getCursor: async () => {
        ensureInitialized();
        const row = loadCursorStmt.get();
        return row ? parseIntSafe(row.value) : 0;
      },
    },
  };
};

export const createSqliteStore = createSqliteClientStore;
