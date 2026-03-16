import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";

const SCHEMA_VERSION = 2;
const DEFAULT_SCAN_CHUNK_SIZE = 512;

const parseCommittedRow = (row) => ({
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partitions: JSON.parse(row.partitions),
  committedId: parseIntSafe(row.committed_id, 0),
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: JSON.parse(row.payload),
  meta: normalizeMeta(JSON.parse(row.meta)),
  created: parseIntSafe(row.created, 0),
});

const toComparisonKey = (event) =>
  canonicalizeSubmitItem({
    partitions: event.partitions,
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

  const runMigrations = async () => {
    let current = await getUserVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${current}; runtime supports up to ${SCHEMA_VERSION}`,
      );
    }

    for (let next = current + 1; next <= SCHEMA_VERSION; next += 1) {
      if (next === 1) {
        await db.execute(`
          CREATE TABLE IF NOT EXISTS committed_events (
            committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            project_id TEXT,
            user_id TEXT,
            partitions TEXT NOT NULL,
            type TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            payload TEXT NOT NULL,
            meta TEXT NOT NULL,
            created INTEGER NOT NULL
          );
        `);
      } else if (next === 2) {
        if (!(await tableHasColumn(db, "committed_events", "schema_version"))) {
          throw new Error(
            "Sync store schemaVersion rollout requires explicit backfill or reset for legacy data",
          );
        }
      } else {
        throw new Error(`Missing migration for schema version ${next}`);
      }
      await setUserVersion(next);
      current = next;
    }
  };

  const getById = async (id) =>
    db.queryOne(
      `
        SELECT
          committed_id,
          id,
          project_id,
          user_id,
          partitions,
          type,
          schema_version,
          payload,
          meta,
          created
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

  const getMaxCommittedIdForPartitionsInternal = async (partitions) => {
    const normalizedPartitions = normalizePartitionSet(partitions);
    if (normalizedPartitions.length === 0) return 0;
    const row = await db.queryOne(
      `
        SELECT COALESCE(MAX(ce.committed_id), 0) AS max_committed_id
        FROM committed_events ce
        WHERE EXISTS (
          SELECT 1
          FROM json_each(ce.partitions) ce_p
          JOIN json_each(?) req_p
            ON CAST(ce_p.value AS TEXT) = CAST(req_p.value AS TEXT)
        )
      `,
      [JSON.stringify(normalizedPartitions)],
    );
    return parseIntSafe(row?.max_committed_id, 0);
  };

  const ensureInitialized = async () => {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await runPragmas();
      await runMigrations();
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
      partitions,
      projectId,
      userId,
      type,
      schemaVersion,
      payload,
      meta,
      now,
    }) => {
      await ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
      const normalizedMeta = normalizeMeta(meta);
      const comparisonKey = canonicalizeSubmitItem({
        partitions: normalizedPartitions,
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
            partitions,
            type,
            schema_version,
            payload,
            meta,
            created
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `,
        [
          id,
          projectId ?? null,
          userId ?? null,
          JSON.stringify(normalizedPartitions),
          type,
          schemaVersion,
          JSON.stringify(payload),
          JSON.stringify(normalizedMeta),
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
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      await ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
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
              project_id,
              user_id,
              partitions,
              type,
              schema_version,
              payload,
              meta,
              created
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
          if (intersectsPartitions(normalizedPartitions, parsed.partitions)) {
            matched.push(parsed);
            if (matched.length > limit) break;
          }
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

    getMaxCommittedIdForPartitions: async ({ partitions }) => {
      await ensureInitialized();
      return getMaxCommittedIdForPartitionsInternal(partitions);
    },
  };
};
