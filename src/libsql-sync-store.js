import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";

const SCHEMA_VERSION = 1;
const DEFAULT_SCAN_CHUNK_SIZE = 512;

const parseCommittedRow = (row) => ({
  id: row.id,
  client_id: row.client_id,
  partitions: JSON.parse(row.partitions),
  committed_id: parseIntSafe(row.committed_id, 0),
  event: JSON.parse(row.event),
  status_updated_at: parseIntSafe(row.status_updated_at, 0),
});

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
            client_id TEXT NOT NULL,
            partitions TEXT NOT NULL,
            event TEXT NOT NULL,
            canonical TEXT NOT NULL,
            status_updated_at INTEGER NOT NULL
          );
        `);
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

    commitOrGetExisting: async ({ id, clientId, partitions, event, now }) => {
      await ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
      const canonical = canonicalizeSubmitItem({
        partitions: normalizedPartitions,
        event,
      });

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
          id,
          clientId,
          JSON.stringify(normalizedPartitions),
          JSON.stringify(event),
          canonical,
          now,
        ],
      );

      const insertedOrExisting = await getById(id);
      if (!insertedOrExisting) {
        throw new Error("commit insert succeeded but row was not readable");
      }

      if (db.rowsAffected(insertResult) === 0) {
        if (insertedOrExisting.canonical !== canonical) {
          const error = new Error("same id submitted with different payload");
          // @ts-ignore
          error.code = "validation_failed";
          throw error;
        }
        return {
          deduped: true,
          committedEvent: parseCommittedRow(insertedOrExisting),
        };
      }

      return {
        deduped: false,
        committedEvent: parseCommittedRow(insertedOrExisting),
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
  };
};
