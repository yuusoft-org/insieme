import {
  canonicalizeSubmitItem,
  intersectsPartitions,
  normalizePartitionSet,
} from "./canonicalize.js";
import { normalizeMeta } from "./event-record.js";

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
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getMaxCommittedIdForPartitionsStmt = null;
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
          project_id TEXT,
          user_id TEXT,
          partitions TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          meta TEXT NOT NULL,
          created INTEGER NOT NULL
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
    projectId: row.project_id || undefined,
    userId: row.user_id || undefined,
    partitions: JSON.parse(row.partitions),
    committedId: row.committed_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    meta: normalizeMeta(JSON.parse(row.meta)),
    created: row.created,
  });

  const toComparisonKey = (event) =>
    canonicalizeSubmitItem({
      partitions: event.partitions,
      projectId: event.projectId,
      userId: event.userId,
      type: event.type,
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
        partitions,
        type,
        payload,
        meta,
        created
      FROM committed_events
      WHERE id = @id
    `);

    insertCommittedStmt = db.prepare(`
      INSERT INTO committed_events(
        id,
        project_id,
        user_id,
        partitions,
        type,
        payload,
        meta,
        created
      ) VALUES (
        @id,
        @project_id,
        @user_id,
        @partitions,
        @type,
        @payload,
        @meta,
        @created
      )
    `);

    listRangeStmt = db.prepare(`
      SELECT
        committed_id,
        id,
        project_id,
        user_id,
        partitions,
        type,
        payload,
        meta,
        created
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

    getMaxCommittedIdForPartitionsStmt = db.prepare(`
      SELECT COALESCE(MAX(ce.committed_id), 0) AS max_committed_id
      FROM committed_events ce
      WHERE EXISTS (
        SELECT 1
        FROM json_each(ce.partitions) ce_p
        JOIN json_each(@partitions_json) req_p
          ON CAST(ce_p.value AS TEXT) = CAST(req_p.value AS TEXT)
      )
    `);

    commitTxn = createTransaction(
      db,
      ({
        id,
        partitions,
        projectId,
        userId,
        type,
        payload,
        meta,
        now,
      }) => {
        const existing = getByIdStmt.get({ id });
        const normalizedMeta = normalizeMeta(meta);
        const comparisonKey = canonicalizeSubmitItem({
          partitions,
          projectId,
          userId,
          type,
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
          project_id: projectId ?? null,
          user_id: userId ?? null,
          partitions: JSON.stringify(partitions),
          type,
          payload: JSON.stringify(payload),
          meta: JSON.stringify(normalizedMeta),
          created: now,
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
      partitions,
      projectId,
      userId,
      type,
      payload,
      meta,
      now,
    }) => {
      ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);

      return commitTxn({
        id,
        partitions: normalizedPartitions,
        projectId,
        userId,
        type,
        payload,
        meta,
        now,
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

    getMaxCommittedIdForPartitions: async ({ partitions }) => {
      ensureInitialized();
      const normalizedPartitions = normalizePartitionSet(partitions);
      if (normalizedPartitions.length === 0) return 0;
      const row = getMaxCommittedIdForPartitionsStmt.get({
        partitions_json: JSON.stringify(normalizedPartitions),
      });
      return parseIntSafe(row?.max_committed_id, 0);
    },
  };
};
