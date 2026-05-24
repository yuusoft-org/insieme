import {
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  buildProjectScopePartition,
  getProjectPartitions,
  partitionSetBelongsToProject,
} from "./partition-scope.js";
import { deserializePayload } from "./payload-codec.js";
import {
  parseStoredEvent,
  parseStoredPartitions,
  toStoredCommitted,
  toStoredComparisonKey,
  withStoredCommittedAliases,
} from "./stored-event.js";

const SCHEMA_VERSION = 5;
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

const tableExists = (db, tableName) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) !== undefined;

const hasCompatibleSchema = (db) => {
  const hasClientId = tableHasColumn(db, "committed_events", "client_id");
  const hasPartitions = tableHasColumn(db, "committed_events", "partitions");
  const hasEvent = tableHasColumn(db, "committed_events", "event");
  const hasCanonical = tableHasColumn(db, "committed_events", "canonical");
  const hasStatusUpdatedAt = tableHasColumn(
    db,
    "committed_events",
    "status_updated_at",
  );
  const eventType = getTableColumnType(db, "committed_events", "event");
  return (
    hasClientId &&
    hasPartitions &&
    hasEvent &&
    hasCanonical &&
    hasStatusUpdatedAt &&
    eventType === "TEXT"
  );
};

const hasLegacyFlatSchema = (db) =>
  tableHasColumn(db, "committed_events", "project_id") &&
  tableHasColumn(db, "committed_events", "partition") &&
  tableHasColumn(db, "committed_events", "type") &&
  tableHasColumn(db, "committed_events", "schema_version") &&
  tableHasColumn(db, "committed_events", "payload") &&
  tableHasColumn(db, "committed_events", "server_ts");

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

  const createSchema = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS committed_events (
        committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        canonical TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );
    `);
  };

  const validateSchema = () => {
    if (!hasCompatibleSchema(db)) {
      throw new Error("Sync store schema is incompatible; reset required");
    }
  };

  const migrateLegacyFlatSchema = () => {
    db.exec(`
      ALTER TABLE committed_events RENAME TO committed_events_legacy_v4;
    `);
    createSchema();

    const rows = db
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
        FROM committed_events_legacy_v4
        ORDER BY committed_id ASC
      `)
      .all();
    const insertMigrated = db.prepare(`
      INSERT INTO committed_events(
        committed_id,
        id,
        client_id,
        partitions,
        event,
        canonical,
        status_updated_at
      ) VALUES (
        @committed_id,
        @id,
        @client_id,
        @partitions,
        @event,
        @canonical,
        @status_updated_at
      )
    `);

    for (const row of rows) {
      const projectId = row.project_id || undefined;
      const partition = row.partition || undefined;
      const statusUpdatedAt = parseIntSafe(row.server_ts, row.created_at || 0);
      const storedEvent = toStoredCommitted({
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
        schemaVersion: parseIntSafe(row.schema_version, 1),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts, 0) },
        status_updated_at: statusUpdatedAt,
        serverTs: statusUpdatedAt,
      });
      insertMigrated.run({
        committed_id: storedEvent.committed_id,
        id: storedEvent.id,
        client_id: storedEvent.client_id || "",
        partitions: JSON.stringify(storedEvent.partitions),
        event: JSON.stringify(storedEvent.event),
        canonical: toComparisonKey(storedEvent),
        status_updated_at: storedEvent.status_updated_at,
      });
    }

    db.exec("DROP TABLE committed_events_legacy_v4;");
    validateSchema();
  };

  const initializeSchema = () => {
    const current = getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    const hasCommittedEventsTable = tableExists(db, "committed_events");
    if (current === 0 && !hasCommittedEventsTable) {
      const initializeTxn = createTransaction(db, () => {
        createSchema();
        validateSchema();
        setUserVersion(SCHEMA_VERSION);
      });
      initializeTxn();
      return;
    }

    if (hasCommittedEventsTable && hasCompatibleSchema(db)) {
      validateSchema();
      if (current !== SCHEMA_VERSION) {
        setUserVersion(SCHEMA_VERSION);
      }
      return;
    }

    if (hasCommittedEventsTable && hasLegacyFlatSchema(db)) {
      const migrationTxn = createTransaction(db, () => {
        migrateLegacyFlatSchema();
        setUserVersion(SCHEMA_VERSION);
      });
      migrationTxn();
      return;
    }

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Sync store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    validateSchema();
  };

  const parseCommittedRow = (row) =>
    withStoredCommittedAliases({
      committed_id: row.committed_id,
      id: row.id,
      client_id: row.client_id,
      partitions: parseStoredPartitions(row.partitions),
      event: parseStoredEvent(row.event),
      status_updated_at: row.status_updated_at,
    });

  const toComparisonKey = (event) => toStoredComparisonKey(event);

  const prepareStatements = () => {
    getByIdStmt = db.prepare(`
      SELECT
        committed_id,
        id,
        client_id,
        partitions,
        event,
        canonical,
        status_updated_at
      FROM committed_events
      WHERE id = @id
    `);

    insertCommittedStmt = db.prepare(`
      INSERT INTO committed_events(
        id,
        client_id,
        partitions,
        event,
        canonical,
        status_updated_at
      ) VALUES (
        @id,
        @client_id,
        @partitions,
        @event,
        @canonical,
        @status_updated_at
      )
    `);

    listRangeStmt = db.prepare(`
      SELECT
        committed_id,
        id,
        client_id,
        partitions,
        event,
        status_updated_at
      FROM committed_events
      WHERE committed_id > @since_committed_id
        AND committed_id <= @upper_bound
      ORDER BY committed_id ASC
      LIMIT @limit
    `);

    getMaxCommittedIdStmt = db.prepare(`
      SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
      FROM committed_events
    `);

    commitTxn = createTransaction(
      db,
      ({
        id,
        clientId,
        partition,
        projectId,
        partitions,
        userId,
        type,
        schemaVersion,
        payload,
        meta,
        event,
        now,
      }) => {
        const existing = getByIdStmt.get({ id });
        const storedEvent = toStoredCommitted({
          id,
          clientId,
          partition,
          projectId,
          userId,
          type,
          schemaVersion,
          payload,
          meta,
          partitions,
          event,
          status_updated_at: now,
          serverTs: now,
        });
        const comparisonKey = toComparisonKey(storedEvent);

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
          client_id: storedEvent.client_id || "unknown",
          partitions: JSON.stringify(storedEvent.partitions),
          event: JSON.stringify(storedEvent.event),
          canonical: comparisonKey,
          status_updated_at: now,
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
    initializeSchema();
    prepareStatements();
    initialized = true;
  };

  const getMaxCommittedIdForProjectInternal = (projectId) => {
    const projectPartitions = normalizePartitionSet(getProjectPartitions(projectId));
    if (projectPartitions.length === 0) return 0;
    const pageSize =
      Number.isInteger(scanChunkSize) && scanChunkSize > 0
        ? scanChunkSize
        : DEFAULT_SCAN_CHUNK_SIZE;
    let maxCommittedId = 0;
    let cursor = 0;
    while (true) {
      const rows = listRangeStmt.all({
        since_committed_id: cursor,
        upper_bound: Number.MAX_SAFE_INTEGER,
        limit: pageSize,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].committed_id;
      for (const row of rows) {
        const parsed = parseCommittedRow(row);
        if (
          intersectsPartitions(projectPartitions, parsed.partitions) &&
          partitionSetBelongsToProject(parsed.partitions, projectId) &&
          parsed.committed_id > maxCommittedId
        ) {
          maxCommittedId = parsed.committed_id;
        }
      }
      if (rows.length < pageSize) break;
    }
    return maxCommittedId;
  };

  return {
    init: async () => {
      ensureInitialized();
    },

    commitOrGetExisting: async ({
      id,
      clientId,
      partition,
      projectId,
      partitions,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      event,
      now,
    }) => {
      ensureInitialized();
      return commitTxn({
        id,
        clientId,
        partition,
        projectId,
        partitions,
        userId,
        type,
        schemaVersion,
        payload,
        meta,
        event,
        now,
      });
    },

    listCommittedSince: async ({
      projectId,
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      ensureInitialized();
      const requestedPartitions = normalizePartitionSet(
        partitions || getProjectPartitions(projectId),
      );
      if (requestedPartitions.length === 0) {
        return {
          events: [],
          hasMore: false,
          nextSinceCommittedId: sinceCommittedId,
        };
      }
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : parseIntSafe(getMaxCommittedIdStmt.get()?.max_committed_id, 0);

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
          const parsed = parseCommittedRow(row);
          if (
            intersectsPartitions(requestedPartitions, parsed.partitions) &&
            partitionSetBelongsToProject(parsed.partitions, projectId)
          ) {
            matched.push(parsed);
          }
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
          ? events[events.length - 1].committed_id
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
      return getMaxCommittedIdForProjectInternal(projectId);
    },
  };
};
