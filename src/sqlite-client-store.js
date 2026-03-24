// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

import { canonicalizeSubmitItem } from "./canonicalize.js";
import { buildCommittedEventFromDraft, normalizeMeta } from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { deserializePayload, serializePayload } from "./payload-codec.js";

const SCHEMA_VERSION = 5;
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

const toComparisonKey = (event) =>
  canonicalizeSubmitItem({
    partition: event.partition,
    projectId: event.projectId,
    userId: event.userId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    meta: event.meta,
  });

const tableHasColumn = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

const parseStoredMeta = (row) => {
  const defaultClientTs = parseIntSafe(row.client_ts);
  return normalizeMeta(JSON.parse(row.meta), {
    defaultClientTs,
  });
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

  /** @type {null|((arg: { result: object }) => object|undefined)} */
  let applySubmitResultTxn = null;
  /** @type {null|((arg: { events: object[], nextCursor?: number }) => object[])} */
  let applyCommittedBatchTxn = null;
  /** @type {null|((arg: { items: object[] }) => void)} */
  let insertDraftsTxn = null;
  let materializedViewRuntime;

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
        project_id TEXT,
        user_id TEXT,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        meta TEXT NOT NULL,
        client_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT,
        user_id TEXT,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        meta TEXT NOT NULL,
        client_ts INTEGER NOT NULL,
        server_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        view_version TEXT NOT NULL,
        last_committed_id INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(view_name, partition)
      );
    `);
  };

  const validateSchema = () => {
    const hasDraftPartition = tableHasColumn(db, "local_drafts", "partition");
    const hasDraftProjectId = tableHasColumn(db, "local_drafts", "project_id");
    const hasDraftUserId = tableHasColumn(db, "local_drafts", "user_id");
    const hasDraftMeta = tableHasColumn(db, "local_drafts", "meta");
    const hasCommittedPartition = tableHasColumn(
      db,
      "committed_events",
      "partition",
    );
    const hasCommittedServerTs = tableHasColumn(
      db,
      "committed_events",
      "server_ts",
    );
    const hasCommittedMeta = tableHasColumn(db, "committed_events", "meta");
    const draftPayloadType = getTableColumnType(db, "local_drafts", "payload");
    const committedPayloadType = getTableColumnType(
      db,
      "committed_events",
      "payload",
    );

    if (
      !hasDraftPartition ||
      !hasDraftProjectId ||
      !hasDraftUserId ||
      !hasDraftMeta ||
      !hasCommittedPartition ||
      !hasCommittedServerTs ||
      !hasCommittedMeta ||
      draftPayloadType !== "BLOB" ||
      committedPayloadType !== "BLOB"
    ) {
      throw new Error("Client store schema is incompatible; reset required");
    }
  };

  const initializeSchema = () => {
    const current = getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    if (current === 0) {
      const initializeTxn = createTransaction(db, () => {
        createSchema();
        validateSchema();
        setUserVersion(SCHEMA_VERSION);
      });
      initializeTxn();
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Client store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    validateSchema();
  };

  const parseDraft = (row) => ({
    draftClock: row.draft_clock,
    id: row.id,
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    partition: row.partition,
    type: row.type,
    schemaVersion: parseIntSafe(row.schema_version),
    payload: deserializePayload(row.payload),
    payloadCompression: row.payload_compression || undefined,
    meta: parseStoredMeta(row),
    createdAt: row.created_at,
  });

  const parseCommittedRow = (row) => ({
    committedId: row.committed_id,
    id: row.id,
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    partition: row.partition,
    type: row.type,
    schemaVersion: parseIntSafe(row.schema_version),
    payload: deserializePayload(row.payload),
    payloadCompression: row.payload_compression || undefined,
    meta: parseStoredMeta(row),
    serverTs: row.server_ts,
    createdAt: row.created_at,
  });

  const encodeMaterializedValue = (value) =>
    JSON.stringify(value === undefined ? null : value);

  const assertCommittedInvariant = (event) => {
    const byId = getCommittedByIdStmt.get({ id: event.id });
    if (byId) {
      const parsedById = parseCommittedRow(byId);
      if (
        parsedById.committedId !== event.committedId ||
        toComparisonKey(parsedById) !== toComparisonKey(event)
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
    }

    const byCommittedId = getCommittedByCommittedIdStmt.get({
      committed_id: event.committedId,
    });
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${event.committedId}: id mismatch`,
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
        project_id,
        user_id,
        partition,
        type,
        schema_version,
        payload,
        payload_compression,
        meta,
        client_ts,
        created_at
      ) VALUES(
        @id,
        @project_id,
        @user_id,
        @partition,
        @type,
        @schema_version,
        @payload,
        @payload_compression,
        @meta,
        @client_ts,
        @created_at
      )
    `);
    listDraftsStmt = db.prepare(`
      SELECT draft_clock, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, created_at
      FROM local_drafts
      ORDER BY draft_clock ASC, id ASC
    `);
    getDraftByIdStmt = db.prepare(`
      SELECT draft_clock, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, created_at
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
        project_id,
        user_id,
        partition,
        type,
        schema_version,
        payload,
        payload_compression,
        meta,
        client_ts,
        server_ts,
        created_at
      ) VALUES (
        @committed_id,
        @id,
        @project_id,
        @user_id,
        @partition,
        @type,
        @schema_version,
        @payload,
        @payload_compression,
        @meta,
        @client_ts,
        @server_ts,
        @created_at
      )
    `);
    getCommittedByIdStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, server_ts, created_at
      FROM committed_events
      WHERE id = @id
    `);
    getCommittedByCommittedIdStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, server_ts, created_at
      FROM committed_events
      WHERE committed_id = @committed_id
    `);
    listCommittedAfterStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, server_ts, created_at
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
      SELECT view_version, last_committed_id, value, updated_at
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

    insertDraftsTxn = createTransaction(db, ({ items }) => {
      for (const item of items) {
        insertDraftStmt.run({
          id: item.id,
          project_id: item.projectId ?? null,
          user_id: item.userId ?? null,
          partition: item.partition,
          type: item.type,
          schema_version: item.schemaVersion,
          payload: serializePayload(item.payload),
          payload_compression: item.payloadCompression ?? null,
          meta: JSON.stringify(normalizeMeta(item.meta)),
          client_ts: parseIntSafe(item.meta?.clientTs),
          created_at: item.createdAt,
        });
      }
    });

    applySubmitResultTxn = createTransaction(db, ({ result }) => {
      let committedEvent;

      if (result.status === "committed") {
        const draft = getDraftByIdStmt.get({ id: result.id });

        if (draft) {
          const parsedDraft = parseDraft(draft);
          const nextCommittedEvent = buildCommittedEventFromDraft({
            draft: parsedDraft,
            committedId: result.committedId,
            serverTs: result.serverTs,
          });
          const insertResult = insertCommittedStmt.run({
            committed_id: nextCommittedEvent.committedId,
            id: nextCommittedEvent.id,
            project_id: nextCommittedEvent.projectId ?? null,
            user_id: nextCommittedEvent.userId ?? null,
            partition: nextCommittedEvent.partition,
            type: nextCommittedEvent.type,
            schema_version: nextCommittedEvent.schemaVersion,
            payload: serializePayload(nextCommittedEvent.payload),
            payload_compression: nextCommittedEvent.payloadCompression ?? null,
            meta: JSON.stringify(normalizeMeta(nextCommittedEvent.meta)),
            client_ts: parseIntSafe(nextCommittedEvent.meta?.clientTs),
            server_ts: nextCommittedEvent.serverTs,
            created_at: Date.now(),
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
        const insertResult = insertCommittedStmt.run({
          committed_id: event.committedId,
          id: event.id,
          project_id: event.projectId ?? null,
          user_id: event.userId ?? null,
          partition: event.partition,
          type: event.type,
          schema_version: event.schemaVersion,
          payload: serializePayload(event.payload),
          payload_compression: event.payloadCompression ?? null,
          meta: JSON.stringify(normalizeMeta(event.meta)),
          client_ts: parseIntSafe(event.meta?.clientTs),
          server_ts: event.serverTs,
          created_at: event.createdAt ?? Date.now(),
        });

        if (insertResult.changes === 0) {
          assertCommittedInvariant(event);
        } else {
          insertedEvents.push({
            ...event,
            payload: structuredClone(event.payload),
            meta: normalizeMeta(event.meta),
          });
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
        return {
          viewVersion: row.view_version,
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
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        deleteMaterializedViewStateStmt.run({
          view_name: viewName,
          partition,
        });
      },
    });

  const ensureInitialized = () => {
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

    loadCursor: async () => {
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
      projectId,
      userId,
      partition,
      type,
      schemaVersion,
      payload,
      meta,
      payloadCompression,
      createdAt,
    }) => {
      ensureInitialized();
      insertDraftStmt.run({
        id,
        project_id: projectId ?? null,
        user_id: userId ?? null,
        partition,
        type,
        schema_version: schemaVersion,
        payload: serializePayload(payload),
        payload_compression: payloadCompression ?? null,
        meta: JSON.stringify(normalizeMeta(meta)),
        client_ts: parseIntSafe(meta?.clientTs),
        created_at: createdAt,
      });
    },

    loadDraftsOrdered: async () => {
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
