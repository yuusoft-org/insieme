import { canonicalizeSubmitItem } from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";
import { deserializePayload, serializePayload } from "./payload-codec.js";

const SCHEMA_VERSION = 4;
const DEFAULT_SCAN_CHUNK_SIZE = 512;

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

const parseIntSafe = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const tableHasColumn = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = (db, tableName, columnName) => {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

export const createSqliteSyncStore = (
  db,
  {
    applyPragmas = true,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
    scanChunkSize = DEFAULT_SCAN_CHUNK_SIZE,
  } = {},
) => {
  let initialized = false;

  /** @type {null|ReturnType<typeof db.prepare>} */
  let getByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let insertCommittedStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let listRangeStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getMaxCommittedIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getMaxCommittedIdForProjectStmt = null;
  /** @type {null|((arg: object) => { deduped: boolean, committedEvent: object })} */
  let commitTxn = null;

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
    return parseIntSafe(row.user_version, 0);
  };

  const setUserVersion = (version) => {
    db.exec(`PRAGMA user_version=${version};`);
  };

  const migrations = [
    () => {
      db.exec(`
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
        CREATE INDEX IF NOT EXISTS committed_events_project_committed_idx
          ON committed_events(project_id, committed_id);
      `);
    },
    () => {
      if (!tableHasColumn(db, "committed_events", "partition")) {
        throw new Error(
          "Sync store requires reset for the singular-partition schema",
        );
      }
    },
    () => {
      if (
        tableHasColumn(db, "committed_events", "partitions") ||
        tableHasColumn(db, "committed_events", "meta")
      ) {
        throw new Error(
          "Sync store legacy committed_events table is incompatible; reset required",
        );
      }
    },
    () => {
      const payloadType = getTableColumnType(db, "committed_events", "payload");
      if (payloadType !== "BLOB") {
        throw new Error("Sync store requires reset for blob payload storage");
      }
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

  const parseCommittedRow = (row) => ({
    id: row.id,
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    partition: row.partition,
    committedId: row.committed_id,
    type: row.type,
    schemaVersion: parseIntSafe(row.schema_version, 0),
    payload: deserializePayload(row.payload),
    payloadCompression: row.payload_compression || undefined,
    meta: normalizeMeta({
      clientTs: parseIntSafe(row.client_ts, 0),
    }),
    serverTs: row.server_ts,
    createdAt: row.created_at,
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

  const prepareStatements = () => {
    getByIdStmt = db.prepare(`
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
      WHERE id = @id
    `);

    insertCommittedStmt = db.prepare(`
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
      ) VALUES (
        @id,
        @project_id,
        @user_id,
        @partition,
        @type,
        @schema_version,
        @payload,
        @payload_compression,
        @client_ts,
        @server_ts,
        @created_at
      )
    `);

    listRangeStmt = db.prepare(`
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
      WHERE project_id = @project_id
        AND committed_id > @since_committed_id
        AND committed_id <= @upper_bound
      ORDER BY committed_id ASC
      LIMIT @limit
    `);

    getMaxCommittedIdStmt = db.prepare(`
      SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
      FROM committed_events
    `);

    getMaxCommittedIdForProjectStmt = db.prepare(`
      SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
      FROM committed_events
      WHERE project_id = @project_id
    `);

    commitTxn = createTransaction(
      db,
      ({
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
        const existing = getByIdStmt.get({ id });
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

        if (existing) {
          const parsedExisting = parseCommittedRow(existing);
          if (toComparisonKey(parsedExisting) !== comparisonKey) {
            const error = new Error("same id submitted with different payload");
            // @ts-ignore
            error.code = "validation_failed";
            throw error;
          }

          return {
            deduped: true,
            committedEvent: parsedExisting,
          };
        }

        insertCommittedStmt.run({
          id,
          project_id: projectId,
          user_id: userId ?? null,
          partition,
          type,
          schema_version: schemaVersion,
          payload: serializePayload(payload),
          payload_compression: null,
          client_ts: parseIntSafe(normalizedMeta.clientTs, 0),
          server_ts: now,
          created_at: now,
        });

        const inserted = getByIdStmt.get({ id });
        if (!inserted) {
          throw new Error("commit insert succeeded but row was not readable");
        }

        return {
          deduped: false,
          committedEvent: parseCommittedRow(inserted),
        };
      },
    );
  };

  const ensureInitialized = () => {
    if (initialized) return;
    runPragmas();
    runMigrations();
    prepareStatements();
    initialized = true;
  };

  return {
    init: async () => {
      ensureInitialized();
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
      ensureInitialized();
      return commitTxn({
        id,
        partition,
        projectId,
        userId,
        type,
        schemaVersion,
        payload,
        meta,
        now,
      });
    },

    listCommittedSince: async ({
      projectId,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      ensureInitialized();
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
          : await (async () => {
              const row = getMaxCommittedIdForProjectStmt.get({
                project_id: projectId,
              });
              return parseIntSafe(row.max_committed_id, 0);
            })();

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
        const rows = listRangeStmt.all({
          project_id: projectId,
          since_committed_id: cursor,
          upper_bound: upperBound,
          limit: pageSize,
        });

        if (rows.length === 0) {
          exhausted = true;
          break;
        }

        cursor = rows[rows.length - 1].committed_id;

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
      ensureInitialized();
      const row = getMaxCommittedIdStmt.get();
      return parseIntSafe(row.max_committed_id, 0);
    },

    getMaxCommittedIdForProject: async ({ projectId }) => {
      ensureInitialized();
      if (!projectId) return 0;
      const row = getMaxCommittedIdForProjectStmt.get({
        project_id: projectId,
      });
      return parseIntSafe(row?.max_committed_id, 0);
    },
  };
};
