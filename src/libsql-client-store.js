import { normalizePartitionSet } from "./canonicalize.js";
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
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { deserializePayload } from "./payload-codec.js";
import { buildProjectScopePartition } from "./partition-scope.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";
import { throwIfClosed } from "./store-errors.js";

const SCHEMA_VERSION = 7;
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 512;

const createTransaction = async (db, fn) => {
  await db.execute("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await db.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // best-effort rollback
    }
    throw error;
  }
};

const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);

const toComparisonKey = (event) => toStoredComparisonKey(event);

const tableHasColumn = async (db, tableName, columnName) => {
  const rows = await db.queryAll(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = async (db, tableName, columnName) => {
  const rows = await db.queryAll(`PRAGMA table_info(${tableName})`);
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

const tableExists = async (db, tableName) => {
  const row = await db.queryOne(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [tableName],
  );
  return row !== undefined && row !== null;
};

const hasCompatibleClientSchema = async (db) => {
  const hasDraftClientId = await tableHasColumn(db, "local_drafts", "client_id");
  const hasDraftPartitions = await tableHasColumn(
    db,
    "local_drafts",
    "partitions",
  );
  const hasDraftEvent = await tableHasColumn(db, "local_drafts", "event");
  const hasCommittedClientId = await tableHasColumn(
    db,
    "committed_events",
    "client_id",
  );
  const hasCommittedPartitions = await tableHasColumn(
    db,
    "committed_events",
    "partitions",
  );
  const hasCommittedEvent = await tableHasColumn(db, "committed_events", "event");
  const hasCommittedStatusUpdatedAt = await tableHasColumn(
    db,
    "committed_events",
    "status_updated_at",
  );
  const draftEventType = await getTableColumnType(db, "local_drafts", "event");
  const committedEventType = await getTableColumnType(db, "committed_events", "event");
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

const hasLegacyFlatClientSchema = async (db) =>
  (await tableHasColumn(db, "local_drafts", "partition")) &&
  (await tableHasColumn(db, "local_drafts", "type")) &&
  (await tableHasColumn(db, "local_drafts", "schema_version")) &&
  (await tableHasColumn(db, "local_drafts", "payload")) &&
  (await tableHasColumn(db, "committed_events", "partition")) &&
  (await tableHasColumn(db, "committed_events", "type")) &&
  (await tableHasColumn(db, "committed_events", "schema_version")) &&
  (await tableHasColumn(db, "committed_events", "payload")) &&
  (await tableHasColumn(db, "committed_events", "server_ts"));

export const createLibsqlClientStore = (
  client,
  {
    applyPragmas = false,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
    materializedViews,
    materializedBackfillChunkSize = DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE,
  } = {},
) => {
  const db = createLibsqlDriver(client);
  let initialized = false;
  let closed = false;
  /** @type {null|Promise<void>} */
  let initPromise = null;
  let materializedViewRuntime;

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

  const parseDraft = (row) =>
    withStoredDraftAliases({
      draftClock: parseIntSafe(row.draft_clock, 0),
      id: row.id,
      clientId: row.client_id,
      partitions: parseStoredPartitions(row.partitions),
      event: parseStoredEvent(row.event),
      createdAt: parseIntSafe(row.created_at, 0),
    });

  const parseCommittedRow = (row) =>
    withStoredCommittedAliases({
      committed_id: parseIntSafe(row.committed_id, 0),
      id: row.id,
      client_id: row.client_id,
      partitions: parseStoredPartitions(row.partitions),
      event: parseStoredEvent(row.event),
      status_updated_at: parseIntSafe(row.status_updated_at, 0),
    });

  const ensureOpen = () => {
    throwIfClosed(closed, "libsql client store", "client_store_closed");
  };

  const runPragmas = async () => {
    if (!applyPragmas) return;
    await db.execute(`PRAGMA journal_mode=${journalMode};`);
    await db.execute(`PRAGMA synchronous=${synchronous};`);
    if (Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0) {
      await db.execute(`PRAGMA busy_timeout=${busyTimeoutMs};`);
    }
  };

  const getUserVersion = async () => {
    const row = await db.queryOne("PRAGMA user_version");
    return parseIntSafe(row?.user_version, 0);
  };

  const setUserVersion = async (version) => {
    await db.execute(`PRAGMA user_version=${version};`);
  };

  const createSchema = async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await createMaterializedSchema();
  };

  const createMaterializedSchema = async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        view_version TEXT,
        last_committed_id INTEGER,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(view_name, partition)
      );
    `);
    if (!(await tableHasColumn(db, "materialized_view_state", "view_version"))) {
      await db.execute(
        "ALTER TABLE materialized_view_state ADD COLUMN view_version TEXT;",
      );
    }
    if (
      !(await tableHasColumn(
        db,
        "materialized_view_state",
        "last_committed_id",
      ))
    ) {
      await db.execute(
        "ALTER TABLE materialized_view_state ADD COLUMN last_committed_id INTEGER;",
      );
    }
    await db.execute(`
      CREATE TABLE IF NOT EXISTS materialized_view_offsets (
        view_name TEXT PRIMARY KEY,
        view_version TEXT NOT NULL,
        last_committed_id INTEGER NOT NULL
      );
    `);
  };

  const validateSchema = async () => {
    if (!(await hasCompatibleClientSchema(db))) {
      throw new Error("Client store schema is incompatible; reset required");
    }
  };

  const migrateLegacyFlatSchema = async () => {
    await db.execute("ALTER TABLE local_drafts RENAME TO local_drafts_legacy_v6;");
    await db.execute(
      "ALTER TABLE committed_events RENAME TO committed_events_legacy_v6;",
    );
    await createSchema();

    const draftRows = await db.queryAll(`
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
    `);
    const committedRows = await db.queryAll(`
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
    `);

    for (const row of draftRows) {
      const draft = toStoredDraft({
        id: row.id,
        clientId: "",
        partition: row.partition || undefined,
        partitions: normalizePartitionSet([row.partition || undefined]),
        type: row.type,
        schemaVersion: parseIntSafe(row.schema_version, 0),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts, 0) },
        createdAt: parseIntSafe(row.created_at, 0),
      });
      await db.execute(
        `
          INSERT INTO local_drafts(
            draft_clock,
            id,
            client_id,
            partitions,
            event,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          parseIntSafe(row.draft_clock, 0),
          draft.id,
          draft.clientId || "",
          JSON.stringify(draft.partitions),
          JSON.stringify(draft.event),
          draft.createdAt,
        ],
      );
    }

    for (const row of committedRows) {
      const projectId = row.project_id || undefined;
      const partition = row.partition || undefined;
      const statusUpdatedAt =
        parseIntSafe(row.server_ts, 0) || parseIntSafe(row.created_at, 0);
      const committed = toStoredCommitted({
        committed_id: parseIntSafe(row.committed_id, 0),
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
        schemaVersion: parseIntSafe(row.schema_version, 0),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts, 0) },
        status_updated_at: statusUpdatedAt,
        serverTs: statusUpdatedAt,
      });
      await db.execute(
        `
          INSERT INTO committed_events(
            committed_id,
            id,
            client_id,
            partitions,
            event,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          committed.committed_id,
          committed.id,
          committed.client_id || "",
          JSON.stringify(committed.partitions),
          JSON.stringify(committed.event),
          committed.status_updated_at,
        ],
      );
    }

    await db.execute("DROP TABLE local_drafts_legacy_v6;");
    await db.execute("DROP TABLE committed_events_legacy_v6;");
    await validateSchema();
  };

  const initializeSchema = async () => {
    const current = await getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    const hasClientTables =
      (await tableExists(db, "local_drafts")) &&
      (await tableExists(db, "committed_events"));
    if (current === 0 && !hasClientTables) {
      await createTransaction(db, async () => {
        await createSchema();
        await validateSchema();
        await setUserVersion(SCHEMA_VERSION);
      });
      return;
    }

    if (hasClientTables && (await hasCompatibleClientSchema(db))) {
      await createMaterializedSchema();
      await validateSchema();
      if (current !== SCHEMA_VERSION) {
        await setUserVersion(SCHEMA_VERSION);
      }
      return;
    }

    if (hasClientTables && (await hasLegacyFlatClientSchema(db))) {
      await createTransaction(db, async () => {
        await migrateLegacyFlatSchema();
        await setUserVersion(SCHEMA_VERSION);
      });
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Client store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    await createMaterializedSchema();
    await validateSchema();
  };

  const assertCommittedInvariant = async (event) => {
    const byId = await db.queryOne(
      `
        SELECT committed_id, id, client_id, partitions, event, status_updated_at
        FROM committed_events
        WHERE id = ?
      `,
      [event.id],
    );
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

    const byCommittedId = await db.queryOne(
      `
        SELECT committed_id, id
        FROM committed_events
        WHERE committed_id = ?
      `,
      [getStoredCommittedId(event)],
    );
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${getStoredCommittedId(event)}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = async (nextCursor) => {
    await db.execute(
      `
        INSERT INTO app_state(key, value)
        VALUES('cursor_committed_id', ?)
        ON CONFLICT(key) DO UPDATE
        SET value = CAST(
          MAX(CAST(app_state.value AS INTEGER), CAST(excluded.value AS INTEGER))
          AS TEXT
        )
      `,
      [String(nextCursor)],
    );
  };

  const createRuntime = () =>
    createMaterializedViewRuntime({
      definitions: materializedViewDefinitions,
      chunkSize: materializedBackfillChunkSize,
      getLatestCommittedId: async () => {
        const row = await db.queryOne(
          `
            SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
            FROM committed_events
          `,
        );
        return parseIntSafe(row?.max_committed_id, 0);
      },
      listCommittedAfter: async ({ sinceCommittedId, limit }) => {
        const rows = await db.queryAll(
          `
            SELECT
              committed_id,
              id,
              client_id,
              partitions,
              event,
              status_updated_at
            FROM committed_events
            WHERE committed_id > ?
            ORDER BY committed_id ASC
            LIMIT ?
          `,
          [sinceCommittedId, limit],
        );
        return rows.map(parseCommittedRow);
      },
      loadCheckpoint: async ({ viewName, partition }) => {
        const row = await db.queryOne(
          `
            SELECT value, updated_at, view_version, last_committed_id
            FROM materialized_view_state
            WHERE view_name = ? AND partition = ?
          `,
          [viewName, partition],
        );
        if (!row) return undefined;
        const offset = await db.queryOne(
          `
            SELECT view_name, view_version, last_committed_id
            FROM materialized_view_offsets
            WHERE view_name = ?
          `,
          [viewName],
        );
        if (row.last_committed_id === null || row.last_committed_id === undefined) {
          return undefined;
        }
        return {
          viewVersion: row.view_version ?? offset?.view_version,
          lastCommittedId: parseIntSafe(row.last_committed_id, 0),
          value: JSON.parse(row.value),
          updatedAt: parseIntSafe(row.updated_at, 0),
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
        await db.execute(
          `
            INSERT INTO materialized_view_state(
              view_name,
              partition,
              view_version,
              last_committed_id,
              value,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(view_name, partition) DO UPDATE
            SET
              view_version = excluded.view_version,
              last_committed_id = excluded.last_committed_id,
              value = excluded.value,
              updated_at = excluded.updated_at
          `,
          [
            viewName,
            partition,
            viewVersion,
            lastCommittedId,
            encodeMaterializedValue(value),
            updatedAt,
          ],
        );
        await db.execute(
          `
            INSERT INTO materialized_view_offsets(
              view_name,
              view_version,
              last_committed_id
            ) VALUES (?, ?, ?)
            ON CONFLICT(view_name) DO UPDATE
            SET
              view_version = excluded.view_version,
              last_committed_id = excluded.last_committed_id
          `,
          [viewName, viewVersion, lastCommittedId],
        );
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        await db.execute(
          `
            DELETE FROM materialized_view_state
            WHERE view_name = ? AND partition = ?
          `,
          [viewName, partition],
        );
      },
    });

  const ensureInitialized = async () => {
    ensureOpen();
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await runPragmas();
      await initializeSchema();
      materializedViewRuntime = createRuntime();
      initialized = true;
    })();

    try {
      await initPromise;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  };

  return {
    init: async () => {
      await ensureInitialized();
    },

    close: async () => {
      if (closed) return;
      closed = true;
      if (materializedViewRuntime) {
        await materializedViewRuntime.flushMaterializedViews();
        await materializedViewRuntime.close();
      }
      if (typeof client.close === "function") {
        await client.close();
      }
    },

    loadCursor: async () => {
      await ensureInitialized();
      const row = await db.queryOne(
        `
          SELECT value
          FROM app_state
          WHERE key = 'cursor_committed_id'
        `,
      );
      return row ? parseIntSafe(row.value, 0) : 0;
    },

    getCursor: async () => {
      await ensureInitialized();
      const row = await db.queryOne(
        `
          SELECT value
          FROM app_state
          WHERE key = 'cursor_committed_id'
        `,
      );
      return row ? parseIntSafe(row.value, 0) : 0;
    },

    insertDraft: async (item) => {
      await ensureInitialized();
      const draft = toStoredDraft(item);
      await db.execute(
        `
          INSERT INTO local_drafts(
            id,
            client_id,
            partitions,
            event,
            created_at
          )
          VALUES(?, ?, ?, ?, ?)
        `,
        [
          draft.id,
          draft.clientId || "unknown",
          JSON.stringify(draft.partitions),
          JSON.stringify(draft.event),
          draft.createdAt,
        ],
      );
    },

    insertDrafts: async (items) => {
      await ensureInitialized();
      await createTransaction(db, async () => {
        for (const item of items) {
          const draft = toStoredDraft(item);
          await db.execute(
            `
              INSERT INTO local_drafts(
                id,
                client_id,
                partitions,
                event,
                created_at
              )
              VALUES(?, ?, ?, ?, ?)
            `,
            [
              draft.id,
              draft.clientId || "unknown",
              JSON.stringify(draft.partitions),
              JSON.stringify(draft.event),
              draft.createdAt,
            ],
          );
        }
      });
    },

    loadDraftsOrdered: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT draft_clock, id, client_id, partitions, event, created_at
        FROM local_drafts
        ORDER BY draft_clock ASC, id ASC
      `);
      return rows.map(parseDraft);
    },

    listDraftsOrdered: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT draft_clock, id, client_id, partitions, event, created_at
        FROM local_drafts
        ORDER BY draft_clock ASC, id ASC
      `);
      return rows.map(parseDraft);
    },

    applySubmitResult: async ({ result }) => {
      await ensureInitialized();
      const committedEvent = await createTransaction(db, async () => {
        let nextCommittedEvent;

        if (result.status === "committed") {
          const draft = await db.queryOne(
            `
              SELECT draft_clock, id, client_id, partitions, event, created_at
              FROM local_drafts
              WHERE id = ?
            `,
            [result.id],
          );

          if (draft) {
            const parsedDraft = parseDraft(draft);
            const committedRecord = buildStoredCommittedFromDraft({
              draft: parsedDraft,
              result,
            });
            const insertResult = await db.execute(
              `
                INSERT OR IGNORE INTO committed_events(
                  committed_id,
                  id,
                  client_id,
                  partitions,
                  event,
                  status_updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
              `,
              [
                committedRecord.committed_id,
                committedRecord.id,
                committedRecord.client_id || "unknown",
                JSON.stringify(committedRecord.partitions),
                JSON.stringify(committedRecord.event),
                committedRecord.status_updated_at,
              ],
            );

            if (db.rowsAffected(insertResult) === 0) {
              await assertCommittedInvariant(committedRecord);
            } else {
              nextCommittedEvent = committedRecord;
            }
          }

          await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
        } else if (result.status === "rejected") {
          await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
        }

        return nextCommittedEvent;
      });

      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await ensureInitialized();
      const insertedEvents = await createTransaction(db, async () => {
        const nextInsertedEvents = [];
        for (const event of events) {
          const committedRecord = toStoredCommitted(event);
          const insertResult = await db.execute(
            `
              INSERT OR IGNORE INTO committed_events(
                committed_id,
                id,
                client_id,
                partitions,
                event,
                status_updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
              committedRecord.committed_id,
              committedRecord.id,
              committedRecord.client_id || "unknown",
              JSON.stringify(committedRecord.partitions),
              JSON.stringify(committedRecord.event),
              committedRecord.status_updated_at,
            ],
          );

          if (db.rowsAffected(insertResult) === 0) {
            await assertCommittedInvariant(committedRecord);
          } else {
            nextInsertedEvents.push(committedRecord);
          }

          await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [event.id]);
        }

        if (nextCursor !== undefined) {
          await saveCursorMonotonic(nextCursor);
        }

        return nextInsertedEvents;
      });

      for (const event of insertedEvents) {
        await materializedViewRuntime.onCommittedEvent(event);
      }
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
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
      await ensureInitialized();
      return materializedViewRuntime.subscribeMaterializedView({
        viewName,
        partition,
        onChange,
        emitCurrent,
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      });
    },

    flushMaterializedViews: async () => {
      await ensureInitialized();
      await materializedViewRuntime.flushMaterializedViews();
    },

    listCommitted: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT committed_id, id, client_id, partitions, event, status_updated_at
        FROM committed_events
        ORDER BY committed_id ASC
      `);
      return rows.map(parseCommittedRow);
    },

    listCommittedAfter: async ({
      sinceCommittedId = 0,
      limit = Number.MAX_SAFE_INTEGER,
    } = {}) => {
      await ensureInitialized();
      const rows = await db.queryAll(
        `
          SELECT
            committed_id,
            id,
            client_id,
            partitions,
            event,
            status_updated_at
          FROM committed_events
          WHERE committed_id > ?
          ORDER BY committed_id ASC
          LIMIT ?
        `,
        [sinceCommittedId, limit],
      );
      return rows.map(parseCommittedRow);
    },

    _debug: {
      getDrafts: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT draft_clock, id, client_id, partitions, event, created_at
          FROM local_drafts
          ORDER BY draft_clock ASC, id ASC
        `);
        return rows.map(parseDraft);
      },
      getCommitted: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT committed_id, id, client_id, partitions, event, status_updated_at
          FROM committed_events
          ORDER BY committed_id ASC
        `);
        return rows.map(parseCommittedRow);
      },
      getCursor: async () => {
        await ensureInitialized();
        const row = await db.queryOne(
          `
            SELECT value
            FROM app_state
            WHERE key = 'cursor_committed_id'
          `,
        );
        return row ? parseIntSafe(row.value, 0) : 0;
      },
    },
  };
};

export const createLibsqlStore = createLibsqlClientStore;
