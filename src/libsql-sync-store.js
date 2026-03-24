import { canonicalizeSubmitItem } from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";
import { deserializePayload, serializePayload } from "./payload-codec.js";

const SCHEMA_VERSION = 4;
const DEFAULT_SCAN_CHUNK_SIZE = 512;

const parseCommittedRow = (row) => ({
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partition: row.partition,
  committedId: parseIntSafe(row.committed_id, 0),
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: deserializePayload(row.payload),
  payloadCompression: row.payload_compression || undefined,
  meta: normalizeMeta({
    clientTs: parseIntSafe(row.client_ts, 0),
  }),
  serverTs: parseIntSafe(row.server_ts, 0),
  createdAt: parseIntSafe(row.created_at, 0),
});

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

export const createLibsqlSyncStore = (
  client,
  {
    applyPragmas = false,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
    scanChunkSize = DEFAULT_SCAN_CHUNK_SIZE,
  } = {},
) => {
  const db = createLibsqlDriver(client);
  let initialized = false;
  /** @type {null|Promise<void>} */
  let initPromise = null;

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
      CREATE TABLE IF NOT EXISTS committed_events (
        committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        user_id TEXT,
        partition TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload BLOB NOT NULL,
        payload_compression TEXT DEFAULT NULL,
        client_ts INTEGER NOT NULL,
        server_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    await db.execute(`
      CREATE INDEX IF NOT EXISTS committed_events_project_committed_idx
      ON committed_events(project_id, committed_id);
    `);
  };

  const validateSchema = async () => {
    const hasPartition = await tableHasColumn(db, "committed_events", "partition");
    const payloadType = await getTableColumnType(
      db,
      "committed_events",
      "payload",
    );
    if (!hasPartition || payloadType !== "BLOB") {
      throw new Error("Sync store schema is incompatible; reset required");
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
      await createSchema();
      await validateSchema();
      await setUserVersion(SCHEMA_VERSION);
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Sync store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    await validateSchema();
  };

  const getById = async (id) =>
    db.queryOne(
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
          client_ts,
          server_ts,
          created_at
        FROM committed_events
        WHERE id = ?
      `,
      [id],
    );

  const getMaxCommittedIdInternal = async () => {
    const row = await db.queryOne(`
      SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
      FROM committed_events
    `);
    return parseIntSafe(row?.max_committed_id, 0);
  };

  const getMaxCommittedIdForProjectInternal = async (projectId) => {
    if (!projectId) return 0;
    const row = await db.queryOne(
      `
        SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
        FROM committed_events
        WHERE project_id = ?
      `,
      [projectId],
    );
    return parseIntSafe(row?.max_committed_id, 0);
  };

  const ensureInitialized = async () => {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await runPragmas();
      await initializeSchema();
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

    commitOrGetExisting: async ({
      id,
      partition,
      projectId,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      now,
    }) => {
      await ensureInitialized();
      const normalizedMeta = normalizeMeta(meta);
      const comparisonKey = canonicalizeSubmitItem({
        partition,
        projectId,
        userId,
        type,
        schemaVersion,
        payload,
        meta: normalizedMeta,
      });

      const insertResult = await db.execute(
        `
          INSERT INTO committed_events(
            id,
            project_id,
            user_id,
            partition,
            type,
            schema_version,
            payload,
            payload_compression,
            client_ts,
            server_ts,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `,
        [
          id,
          projectId,
          userId ?? null,
          partition,
          type,
          schemaVersion,
          serializePayload(payload),
          null,
          parseIntSafe(normalizedMeta.clientTs, 0),
          now,
          now,
        ],
      );

      const insertedOrExisting = await getById(id);
      if (!insertedOrExisting) {
        throw new Error("commit insert succeeded but row was not readable");
      }

      const parsed = parseCommittedRow(insertedOrExisting);
      if (db.rowsAffected(insertResult) === 0) {
        if (toComparisonKey(parsed) !== comparisonKey) {
          const error = new Error("same id submitted with different payload");
          // @ts-ignore
          error.code = "validation_failed";
          throw error;
        }
        return {
          deduped: true,
          committedEvent: parsed,
        };
      }

      return {
        deduped: false,
        committedEvent: parsed,
      };
    },

    listCommittedSince: async ({
      projectId,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      await ensureInitialized();
      if (!projectId) {
        return {
          events: [],
          hasMore: false,
          nextSinceCommittedId: sinceCommittedId,
        };
      }
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : await getMaxCommittedIdForProjectInternal(projectId);

      const pageSize = Math.max(
        limit + 1,
        Number.isInteger(scanChunkSize) && scanChunkSize > 0
          ? scanChunkSize
          : DEFAULT_SCAN_CHUNK_SIZE,
      );

      /** @type {object[]} */
      const matched = [];
      let cursor = sinceCommittedId;
      let exhausted = false;

      while (!exhausted && matched.length <= limit) {
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
              client_ts,
              server_ts,
              created_at
            FROM committed_events
            WHERE project_id = ?
              AND committed_id > ?
              AND committed_id <= ?
            ORDER BY committed_id ASC
            LIMIT ?
          `,
          [projectId, cursor, upperBound, pageSize],
        );

        if (rows.length === 0) {
          exhausted = true;
          break;
        }

        cursor = parseIntSafe(rows[rows.length - 1].committed_id, 0);

        for (const row of rows) {
          matched.push(parseCommittedRow(row));
          if (matched.length > limit) break;
        }

        if (rows.length < pageSize) {
          exhausted = true;
        }
      }

      const events = matched.slice(0, limit);
      const hasMore = matched.length > limit;
      const nextSinceCommittedId =
        events.length > 0
          ? events[events.length - 1].committedId
          : sinceCommittedId;

      return {
        events,
        hasMore,
        nextSinceCommittedId,
      };
    },

    getMaxCommittedId: async () => {
      await ensureInitialized();
      return getMaxCommittedIdInternal();
    },

    getMaxCommittedIdForProject: async ({ projectId }) => {
      await ensureInitialized();
      return getMaxCommittedIdForProjectInternal(projectId);
    },
  };
};
