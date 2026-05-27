import {
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  buildProjectScopePartition,
  extractProjectScopeIds,
  getProjectPartitions,
  partitionSetBelongsToProject,
} from "./partition-scope.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";
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
const LEGACY_PROJECT_KEY = "__global__";

const deriveProjectKey = ({ projectId, partitions = [] } = {}) => {
  if (typeof projectId === "string" && projectId.length > 0) return projectId;
  const projectIds = extractProjectScopeIds(normalizePartitionSet(partitions));
  return projectIds[0] || LEGACY_PROJECT_KEY;
};

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
  return row !== null && row !== undefined;
};

const runTransaction = async (db, fn) => {
  await db.execute("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await db.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
};

const hasCompatibleSchema = async (db) => {
  const hasProjectKey = await tableHasColumn(db, "committed_events", "project_key");
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
  return (
    hasProjectKey &&
    hasClientId &&
    hasPartitions &&
    hasEvent &&
    hasCanonical &&
    hasStatusUpdatedAt &&
    eventType === "TEXT"
  );
};

const hasLegacyCanonicalSchema = async (db) => {
  const hasProjectKey = await tableHasColumn(db, "committed_events", "project_key");
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
  return (
    !hasProjectKey &&
    hasClientId &&
    hasPartitions &&
    hasEvent &&
    hasCanonical &&
    hasStatusUpdatedAt &&
    eventType === "TEXT"
  );
};

const hasLegacyFlatSchema = async (db) =>
  (await tableHasColumn(db, "committed_events", "project_id")) &&
  (await tableHasColumn(db, "committed_events", "partition")) &&
  (await tableHasColumn(db, "committed_events", "type")) &&
  (await tableHasColumn(db, "committed_events", "schema_version")) &&
  (await tableHasColumn(db, "committed_events", "payload")) &&
  (await tableHasColumn(db, "committed_events", "server_ts"));

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
        id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        canonical TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL,
        UNIQUE(project_key, id)
      );
    `);
  };

  const createProjectScanIndex = async () => {
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_committed_events_project_committed_id
      ON committed_events(project_key, committed_id);
    `);
  };

  const validateSchema = async () => {
    if (!(await hasCompatibleSchema(db))) {
      throw new Error("Sync store schema is incompatible; reset required");
    }
  };

  const migrateLegacyCanonicalSchema = async () => {
    await db.execute("ALTER TABLE committed_events RENAME TO committed_events_legacy_v5;");
    await createSchema();

    const rows = await db.queryAll(`
      SELECT
        committed_id,
        id,
        client_id,
        partitions,
        event,
        canonical,
        status_updated_at
      FROM committed_events_legacy_v5
      ORDER BY committed_id ASC
    `);

    for (const row of rows) {
      await db.execute(
        `
          INSERT INTO committed_events(
            committed_id,
            id,
            project_key,
            client_id,
            partitions,
            event,
            canonical,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          row.committed_id,
          row.id,
          deriveProjectKey({ partitions: parseStoredPartitions(row.partitions) }),
          row.client_id || "",
          row.partitions,
          row.event,
          row.canonical,
          row.status_updated_at,
        ],
      );
    }

    await db.execute("DROP TABLE committed_events_legacy_v5;");
    await validateSchema();
  };

  const migrateLegacyFlatSchema = async () => {
    await db.execute("ALTER TABLE committed_events RENAME TO committed_events_legacy_v4;");
    await createSchema();

    const rows = await db.queryAll(`
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
    `);

    for (const row of rows) {
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
        schemaVersion: parseIntSafe(row.schema_version, 1),
        payload: deserializePayload(row.payload),
        meta: { clientTs: parseIntSafe(row.client_ts, 0) },
        status_updated_at: statusUpdatedAt,
        serverTs: statusUpdatedAt,
      });
      const comparisonKey = toComparisonKey(committed);
      await db.execute(
        `
          INSERT INTO committed_events(
            committed_id,
            id,
            project_key,
            client_id,
            partitions,
            event,
            canonical,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          committed.committed_id,
          committed.id,
          deriveProjectKey({
            projectId,
            partitions: committed.partitions,
          }),
          committed.client_id || "",
          JSON.stringify(committed.partitions),
          JSON.stringify(committed.event),
          comparisonKey,
          committed.status_updated_at,
        ],
      );
    }

    await db.execute("DROP TABLE committed_events_legacy_v4;");
    await validateSchema();
  };

  const initializeSchema = async () => {
    const current = await getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    const hasCommittedEventsTable = await tableExists(db, "committed_events");
    if (!hasCommittedEventsTable) {
      if (current === 0) {
        await runTransaction(db, async () => {
          await createSchema();
          await createProjectScanIndex();
          await validateSchema();
          await setUserVersion(SCHEMA_VERSION);
        });
        return;
      }
      throw new Error("Sync store schema is incompatible; reset required");
    }

    if (await hasCompatibleSchema(db)) {
      await createProjectScanIndex();
      await validateSchema();
      if (current !== SCHEMA_VERSION) {
        await setUserVersion(SCHEMA_VERSION);
      }
      return;
    }

    if (await hasLegacyCanonicalSchema(db)) {
      await runTransaction(db, async () => {
        await migrateLegacyCanonicalSchema();
        await createProjectScanIndex();
        await setUserVersion(SCHEMA_VERSION);
      });
      return;
    }

    if (await hasLegacyFlatSchema(db)) {
      await runTransaction(db, async () => {
        await migrateLegacyFlatSchema();
        await createProjectScanIndex();
        await setUserVersion(SCHEMA_VERSION);
      });
      return;
    }

    throw new Error("Sync store schema is incompatible; reset required");
  };

  const getByProjectAndId = async (projectKey, id) =>
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
        WHERE project_key = ?
          AND id = ?
      `,
      [projectKey, id],
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
          WHERE project_key = ?
            AND committed_id > ?
          ORDER BY committed_id ASC
          LIMIT ?
        `,
        [projectId, cursor, pageSize],
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
      await ensureInitialized();
      const storedEvent = toStoredCommitted({
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
        status_updated_at: now,
        serverTs: now,
      });
      const comparisonKey = toComparisonKey(storedEvent);
      const projectKey = deriveProjectKey({
        projectId,
        partitions: storedEvent.partitions,
      });

      const insertResult = await db.execute(
        `
          INSERT INTO committed_events(
            id,
            project_key,
            client_id,
            partitions,
            event,
            canonical,
            status_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_key, id) DO NOTHING
        `,
        [
          storedEvent.id,
          projectKey,
          storedEvent.client_id || "unknown",
          JSON.stringify(storedEvent.partitions),
          JSON.stringify(storedEvent.event),
          comparisonKey,
          now,
        ],
      );

      const insertedOrExisting = await getByProjectAndId(projectKey, id);
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
            WHERE project_key = ?
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
