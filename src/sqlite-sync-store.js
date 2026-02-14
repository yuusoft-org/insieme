import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";

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

  const migrations = [
    () => {
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
    client_id: row.client_id,
    partitions: JSON.parse(row.partitions),
    committed_id: row.committed_id,
    event: JSON.parse(row.event),
    status_updated_at: row.status_updated_at,
  });

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
      ({ id, clientId, partitions, event, now, canonical }) => {
        const existing = getByIdStmt.get({ id });
        if (existing) {
          if (existing.canonical !== canonical) {
            const error = new Error("same id submitted with different payload");
            // @ts-ignore
            error.code = "validation_failed";
            throw error;
          }

          return {
            deduped: true,
            committedEvent: parseCommittedRow(existing),
          };
        }

        insertCommittedStmt.run({
          id,
          client_id: clientId,
          partitions: JSON.stringify(partitions),
          event: JSON.stringify(event),
          canonical,
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
    runMigrations();
    prepareStatements();
    initialized = true;
  };

  return {
    init: async () => {
      ensureInitialized();
    },

    commitOrGetExisting: async ({ id, clientId, partitions, event, now }) => {
      ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
      const canonical = canonicalizeSubmitItem({
        partitions: normalizedPartitions,
        event,
      });

      return commitTxn({
        id,
        clientId,
        partitions: normalizedPartitions,
        event,
        now,
        canonical,
      });
    },

    listCommittedSince: async ({
      partitions,
      sinceCommittedId,
      limit,
      syncToCommittedId,
    }) => {
      ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
      const upperBound =
        syncToCommittedId !== undefined
          ? syncToCommittedId
          : await (async () => {
              const row = getMaxCommittedIdStmt.get();
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
      ensureInitialized();
      const row = getMaxCommittedIdStmt.get();
      return parseIntSafe(row.max_committed_id, 0);
    },
  };
};
