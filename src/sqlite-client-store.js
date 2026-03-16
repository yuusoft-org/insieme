// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

import { canonicalizeSubmitItem } from "./canonicalize.js";
import { buildCommittedEventFromDraft, normalizeMeta } from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";

const SCHEMA_VERSION = 1;
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
    partitions: event.partitions,
    projectId: event.projectId,
    userId: event.userId,
    type: event.type,
    payload: event.payload,
    meta: event.meta,
  });

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

  const migrations = [
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_drafts (
          draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          partitions TEXT NOT NULL,
          project_id TEXT,
          user_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          meta TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS committed_events (
          committed_id INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          project_id TEXT,
          user_id TEXT,
          partitions TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          meta TEXT NOT NULL,
          created INTEGER NOT NULL
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
    partitions: JSON.parse(row.partitions),
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    type: row.type,
    payload: JSON.parse(row.payload),
    meta: normalizeMeta(JSON.parse(row.meta)),
    createdAt: row.created_at,
  });

  const parseCommittedRow = (row) => ({
    committedId: row.committed_id,
    id: row.id,
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    partitions: JSON.parse(row.partitions),
    type: row.type,
    payload: JSON.parse(row.payload),
    meta: normalizeMeta(JSON.parse(row.meta)),
    created: row.created,
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
        partitions,
        project_id,
        user_id,
        type,
        payload,
        meta,
        created_at
      ) VALUES(
        @id,
        @partitions,
        @project_id,
        @user_id,
        @type,
        @payload,
        @meta,
        @created_at
      )
    `);
    listDraftsStmt = db.prepare(`
      SELECT draft_clock, id, partitions, project_id, user_id, type, payload, meta, created_at
      FROM local_drafts
      ORDER BY draft_clock ASC, id ASC
    `);
    getDraftByIdStmt = db.prepare(`
      SELECT draft_clock, id, partitions, project_id, user_id, type, payload, meta, created_at
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
        partitions,
        type,
        payload,
        meta,
        created
      ) VALUES (
        @committed_id,
        @id,
        @project_id,
        @user_id,
        @partitions,
        @type,
        @payload,
        @meta,
        @created
      )
    `);
    getCommittedByIdStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partitions, type, payload, meta, created
      FROM committed_events
      WHERE id = @id
    `);
    getCommittedByCommittedIdStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partitions, type, payload, meta, created
      FROM committed_events
      WHERE committed_id = @committed_id
    `);
    listCommittedAfterStmt = db.prepare(`
      SELECT committed_id, id, project_id, user_id, partitions, type, payload, meta, created
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

    applySubmitResultTxn = createTransaction(db, ({ result }) => {
      let committedEvent;

      if (result.status === "committed") {
        const draft = getDraftByIdStmt.get({ id: result.id });

        if (draft) {
          const parsedDraft = parseDraft(draft);
          const nextCommittedEvent = buildCommittedEventFromDraft({
            draft: parsedDraft,
            committedId: result.committedId,
            created: result.created,
          });
          const insertResult = insertCommittedStmt.run({
            committed_id: nextCommittedEvent.committedId,
            id: nextCommittedEvent.id,
            project_id: nextCommittedEvent.projectId ?? null,
            user_id: nextCommittedEvent.userId ?? null,
            partitions: JSON.stringify(nextCommittedEvent.partitions),
            type: nextCommittedEvent.type,
            payload: JSON.stringify(nextCommittedEvent.payload),
            meta: JSON.stringify(nextCommittedEvent.meta),
            created: nextCommittedEvent.created,
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
          partitions: JSON.stringify(event.partitions),
          type: event.type,
          payload: JSON.stringify(event.payload),
          meta: JSON.stringify(normalizeMeta(event.meta)),
          created: event.created,
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
    runMigrations();
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

    insertDraft: async ({
      id,
      partitions,
      projectId,
      userId,
      type,
      payload,
      meta,
      createdAt,
    }) => {
      ensureInitialized();
      insertDraftStmt.run({
        id,
        partitions: JSON.stringify(partitions),
        project_id: projectId ?? null,
        user_id: userId ?? null,
        type,
        payload: JSON.stringify(payload),
        meta: JSON.stringify(normalizeMeta(meta)),
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

    loadMaterializedViews: async ({ viewName, partitions }) => {
      ensureInitialized();
      return materializedViewRuntime.loadMaterializedViews({
        viewName,
        partitions,
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
