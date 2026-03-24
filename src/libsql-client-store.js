import { canonicalizeSubmitItem } from "./canonicalize.js";
import { buildCommittedEventFromDraft, normalizeMeta } from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";
import { deserializePayload, serializePayload } from "./payload-codec.js";

const SCHEMA_VERSION = 5;
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

const parseStoredMeta = (row) =>
  normalizeMeta(JSON.parse(row.meta), {
    defaultClientTs: parseIntSafe(row.client_ts, 0),
  });

const parseDraft = (row) => ({
  draftClock: parseIntSafe(row.draft_clock, 0),
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partition: row.partition,
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: deserializePayload(row.payload),
  payloadCompression: row.payload_compression || undefined,
  meta: parseStoredMeta(row),
  createdAt: parseIntSafe(row.created_at, 0),
});

const parseCommittedRow = (row) => ({
  committedId: parseIntSafe(row.committed_id, 0),
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partition: row.partition,
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: deserializePayload(row.payload),
  payloadCompression: row.payload_compression || undefined,
  meta: parseStoredMeta(row),
  serverTs: parseIntSafe(row.server_ts, 0),
  createdAt: parseIntSafe(row.created_at, 0),
});

const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);

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

const tableHasColumn = async (db, tableName, columnName) => {
  const rows = await db.queryAll(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = async (db, tableName, columnName) => {
  const rows = await db.queryAll(`PRAGMA table_info(${tableName})`);
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

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
  /** @type {null|Promise<void>} */
  let initPromise = null;
  let materializedViewRuntime;

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

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
    `);
    await db.execute(`
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
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await db.execute(`
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

  const validateSchema = async () => {
    const hasDraftPartition = await tableHasColumn(db, "local_drafts", "partition");
    const hasDraftProjectId = await tableHasColumn(
      db,
      "local_drafts",
      "project_id",
    );
    const hasDraftUserId = await tableHasColumn(db, "local_drafts", "user_id");
    const hasDraftMeta = await tableHasColumn(db, "local_drafts", "meta");
    const hasCommittedPartition = await tableHasColumn(
      db,
      "committed_events",
      "partition",
    );
    const hasCommittedServerTs = await tableHasColumn(
      db,
      "committed_events",
      "server_ts",
    );
    const hasCommittedMeta = await tableHasColumn(
      db,
      "committed_events",
      "meta",
    );
    const draftPayloadType = await getTableColumnType(
      db,
      "local_drafts",
      "payload",
    );
    const committedPayloadType = await getTableColumnType(
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

  const initializeSchema = async () => {
    const current = await getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    if (current === 0) {
      await createTransaction(db, async () => {
        await createSchema();
        await validateSchema();
        await setUserVersion(SCHEMA_VERSION);
      });
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Client store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    await validateSchema();
  };

  const assertCommittedInvariant = async (event) => {
    const byId = await db.queryOne(
      `
        SELECT committed_id, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, server_ts, created_at
        FROM committed_events
        WHERE id = ?
      `,
      [event.id],
    );
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

    const byCommittedId = await db.queryOne(
      `
        SELECT committed_id, id
        FROM committed_events
        WHERE committed_id = ?
      `,
      [event.committedId],
    );
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${event.committedId}: id mismatch`,
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
            SELECT view_version, last_committed_id, value, updated_at
            FROM materialized_view_state
            WHERE view_name = ? AND partition = ?
          `,
          [viewName, partition],
        );
        if (!row) return undefined;
        return {
          viewVersion: row.view_version,
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
      await ensureInitialized();
      await db.execute(
        `
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
          )
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          projectId ?? null,
          userId ?? null,
          partition,
          type,
          schemaVersion,
          serializePayload(payload),
          payloadCompression ?? null,
          JSON.stringify(normalizeMeta(meta)),
          parseIntSafe(meta?.clientTs, 0),
          createdAt,
        ],
      );
    },

    insertDrafts: async (items) => {
      await ensureInitialized();
      await createTransaction(db, async () => {
        for (const item of items) {
          await db.execute(
            `
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
              )
              VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              item.id,
              item.projectId ?? null,
              item.userId ?? null,
              item.partition,
              item.type,
              item.schemaVersion,
              serializePayload(item.payload),
              item.payloadCompression ?? null,
              JSON.stringify(normalizeMeta(item.meta)),
              parseIntSafe(item.meta?.clientTs, 0),
              item.createdAt,
            ],
          );
        }
      });
    },

    loadDraftsOrdered: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT draft_clock, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, created_at
        FROM local_drafts
        ORDER BY draft_clock ASC, id ASC
      `);
      return rows.map(parseDraft);
    },

    applySubmitResult: async ({ result }) => {
      await ensureInitialized();
      let committedEvent;

      if (result.status === "committed") {
        const draft = await db.queryOne(
          `
            SELECT draft_clock, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, created_at
            FROM local_drafts
            WHERE id = ?
          `,
          [result.id],
        );

        if (draft) {
          const parsedDraft = parseDraft(draft);
          const nextCommittedEvent = buildCommittedEventFromDraft({
            draft: parsedDraft,
            committedId: result.committedId,
            serverTs: result.serverTs,
          });
          const insertResult = await db.execute(
            `
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
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              nextCommittedEvent.committedId,
              nextCommittedEvent.id,
              nextCommittedEvent.projectId ?? null,
              nextCommittedEvent.userId ?? null,
              nextCommittedEvent.partition,
              nextCommittedEvent.type,
              nextCommittedEvent.schemaVersion,
              serializePayload(nextCommittedEvent.payload),
              nextCommittedEvent.payloadCompression ?? null,
              JSON.stringify(normalizeMeta(nextCommittedEvent.meta)),
              parseIntSafe(nextCommittedEvent.meta?.clientTs, 0),
              nextCommittedEvent.serverTs,
              Date.now(),
            ],
          );

          if (db.rowsAffected(insertResult) === 0) {
            await assertCommittedInvariant(nextCommittedEvent);
          } else {
            committedEvent = nextCommittedEvent;
          }
        }

        await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
      } else if (result.status === "rejected") {
        await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
      }

      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await ensureInitialized();

      const insertedEvents = [];
      for (const event of events) {
        const insertResult = await db.execute(
          `
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            event.committedId,
            event.id,
            event.projectId ?? null,
            event.userId ?? null,
            event.partition,
            event.type,
            event.schemaVersion,
            serializePayload(event.payload),
            event.payloadCompression ?? null,
            JSON.stringify(normalizeMeta(event.meta)),
            parseIntSafe(event.meta?.clientTs, 0),
            event.serverTs,
            event.createdAt ?? Date.now(),
          ],
        );

        if (db.rowsAffected(insertResult) === 0) {
          await assertCommittedInvariant(event);
        } else {
          insertedEvents.push({
            ...event,
            payload: structuredClone(event.payload),
            meta: normalizeMeta(event.meta),
          });
        }

        await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [event.id]);
      }

      if (nextCursor !== undefined) {
        await saveCursorMonotonic(nextCursor);
      }

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

    _debug: {
      getDrafts: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT draft_clock, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, created_at
          FROM local_drafts
          ORDER BY draft_clock ASC, id ASC
        `);
        return rows.map(parseDraft);
      },
      getCommitted: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT committed_id, id, project_id, user_id, partition, type, schema_version, payload, payload_compression, meta, client_ts, server_ts, created_at
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
