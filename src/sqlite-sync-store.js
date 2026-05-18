import {
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  getProjectPartitions,
  partitionSetBelongsToProject,
} from "./partition-scope.js";
import {
  parseStoredEvent,
  parseStoredPartitions,
  toStoredCommitted,
  toStoredComparisonKey,
  withStoredCommittedAliases,
} from "./stored-event.js";

const SCHEMA_VERSION = 1;
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
    if (
      !hasClientId ||
      !hasPartitions ||
      !hasEvent ||
      !hasCanonical ||
      !hasStatusUpdatedAt ||
      eventType !== "TEXT"
    ) {
      throw new Error("Sync store schema is incompatible; reset required");
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
