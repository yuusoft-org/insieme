import {
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  getProjectPartitions,
  partitionSetBelongsToProject,
} from "./partition-scope.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";
import {
  parseStoredEvent,
  parseStoredPartitions,
  toStoredCommitted,
  toStoredComparisonKey,
  withStoredCommittedAliases,
} from "./stored-event.js";

const SCHEMA_VERSION = 1;
const DEFAULT_SCAN_CHUNK_SIZE = 512;

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

  const parseCommittedRow = (row) =>
    withStoredCommittedAliases({
      committed_id: parseIntSafe(row.committed_id, 0),
      id: row.id,
      client_id: row.client_id,
      partitions: parseStoredPartitions(row.partitions),
      event: parseStoredEvent(row.event),
      status_updated_at: parseIntSafe(row.status_updated_at, 0),
    });

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
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        canonical TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      );
    `);
  };

  const validateSchema = async () => {
    const hasClientId = await tableHasColumn(db, "committed_events", "client_id");
    const hasPartitions = await tableHasColumn(
      db,
      "committed_events",
      "partitions",
    );
    const hasEvent = await tableHasColumn(db, "committed_events", "event");
    const hasCanonical = await tableHasColumn(db, "committed_events", "canonical");
    const hasStatusUpdatedAt = await tableHasColumn(
      db,
      "committed_events",
      "status_updated_at",
    );
    const eventType = await getTableColumnType(db, "committed_events", "event");
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
          client_id,
          partitions,
          event,
          canonical,
          status_updated_at
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
    const projectPartitions = normalizePartitionSet(getProjectPartitions(projectId));
    if (projectPartitions.length === 0) return 0;
    const pageSize =
      Number.isInteger(scanChunkSize) && scanChunkSize > 0
        ? scanChunkSize
        : DEFAULT_SCAN_CHUNK_SIZE;
    let maxCommittedId = 0;
    let cursor = 0;
    while (true) {
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
        [cursor, pageSize],
      );
      if (rows.length === 0) break;
      cursor = parseIntSafe(rows[rows.length - 1].committed_id, 0);
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
      partitions,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      event,
      now,
    }) => {
      await ensureInitialized();
      const storedEvent = toStoredCommitted({
        id,
        partition,
        projectId,
        partitions,
        userId,
        type,
        schemaVersion,
        payload,
        meta,
        event,
        status_updated_at: now,
        serverTs: now,
      });
      const comparisonKey = toComparisonKey(storedEvent);

      const insertResult = await db.execute(
        `
          INSERT INTO committed_events(
            id,
            client_id,
            partitions,
            event,
            canonical,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `,
        [
          storedEvent.id,
          storedEvent.client_id || "unknown",
          JSON.stringify(storedEvent.partitions),
          JSON.stringify(storedEvent.event),
          comparisonKey,
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
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      await ensureInitialized();
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
          : await getMaxCommittedIdInternal();

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
              client_id,
              partitions,
              event,
              status_updated_at
            FROM committed_events
            WHERE committed_id > ?
              AND committed_id <= ?
            ORDER BY committed_id ASC
            LIMIT ?
          `,
          [cursor, upperBound, pageSize],
        );

        if (rows.length === 0) {
          exhausted = true;
          break;
        }

        cursor = parseIntSafe(rows[rows.length - 1].committed_id, 0);

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
      await ensureInitialized();
      return getMaxCommittedIdInternal();
    },

    getMaxCommittedIdForProject: async ({ projectId }) => {
      await ensureInitialized();
      return getMaxCommittedIdForProjectInternal(projectId);
    },
  };
};
