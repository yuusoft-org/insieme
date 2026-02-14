// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

const SCHEMA_VERSION = 1;

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

const parseIntSafe = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
};

export const createSqliteClientStore = (
  db,
  {
    applyPragmas = true,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
  } = {},
) => {
  let initialized = false;

  /** @type {null|ReturnType<typeof db.prepare>} */
  let loadCursorStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let saveCursorStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let insertDraftStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let listDraftsStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getDraftByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let deleteDraftByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let insertCommittedStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getCommittedByIdStmt = null;
  /** @type {null|ReturnType<typeof db.prepare>} */
  let getCommittedByCommittedIdStmt = null;

  /** @type {null|((arg: { result: object, fallbackClientId: string }) => void)} */
  let applySubmitResultTxn = null;
  /** @type {null|((arg: { events: object[], nextCursor?: number }) => void)} */
  let applyCommittedBatchTxn = null;

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
    return parseIntSafe(row.user_version);
  };

  const setUserVersion = (version) => {
    db.exec(`PRAGMA user_version=${version};`);
  };

  const migrations = [
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_drafts (
          draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS committed_events (
          committed_id INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          status_updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
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

  const parseDraft = (row) => ({
    draftClock: row.draft_clock,
    id: row.id,
    clientId: row.client_id,
    partitions: JSON.parse(row.partitions),
    event: JSON.parse(row.event),
    createdAt: row.created_at,
  });

  const assertCommittedInvariant = (event) => {
    const byId = getCommittedByIdStmt.get({ id: event.id });
    if (byId && byId.committed_id !== event.committed_id) {
      throw new Error(
        `committed event invariant violation for id ${event.id}: committed_id mismatch`,
      );
    }

    const byCommittedId = getCommittedByCommittedIdStmt.get({
      committed_id: event.committed_id,
    });
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committed_id ${event.committed_id}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = (nextCursor) => {
    const row = loadCursorStmt.get();
    const currentCursor = row ? parseIntSafe(row.value) : 0;
    const effectiveCursor = Math.max(currentCursor, nextCursor);
    saveCursorStmt.run({ value: String(effectiveCursor) });
  };

  const prepareStatements = () => {
    loadCursorStmt = db.prepare(
      `SELECT value FROM app_state WHERE key = 'cursor_committed_id'`,
    );
    saveCursorStmt = db.prepare(`
      INSERT INTO app_state(key, value)
      VALUES('cursor_committed_id', @value)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);

    insertDraftStmt = db.prepare(`
      INSERT INTO local_drafts(id, client_id, partitions, event, created_at)
      VALUES(@id, @client_id, @partitions, @event, @created_at)
    `);
    listDraftsStmt = db.prepare(`
      SELECT draft_clock, id, client_id, partitions, event, created_at
      FROM local_drafts
      ORDER BY draft_clock ASC, id ASC
    `);
    getDraftByIdStmt = db.prepare(`
      SELECT draft_clock, id, client_id, partitions, event, created_at
      FROM local_drafts
      WHERE id = @id
    `);
    deleteDraftByIdStmt = db.prepare(`
      DELETE FROM local_drafts WHERE id = @id
    `);

    insertCommittedStmt = db.prepare(`
      INSERT OR IGNORE INTO committed_events(
        committed_id,
        id,
        client_id,
        partitions,
        event,
        status_updated_at
      ) VALUES (
        @committed_id,
        @id,
        @client_id,
        @partitions,
        @event,
        @status_updated_at
      )
    `);
    getCommittedByIdStmt = db.prepare(`
      SELECT committed_id, id, client_id, partitions, event, status_updated_at
      FROM committed_events
      WHERE id = @id
    `);
    getCommittedByCommittedIdStmt = db.prepare(`
      SELECT committed_id, id, client_id, partitions, event, status_updated_at
      FROM committed_events
      WHERE committed_id = @committed_id
    `);

    applySubmitResultTxn = createTransaction(
      db,
      ({ result, fallbackClientId }) => {
        if (result.status === "committed") {
          const draft = getDraftByIdStmt.get({ id: result.id });

          if (draft) {
            const insertResult = insertCommittedStmt.run({
              committed_id: result.committed_id,
              id: result.id,
              client_id: draft.client_id || fallbackClientId,
              partitions: draft.partitions,
              event: draft.event,
              status_updated_at: result.status_updated_at,
            });
            if (insertResult.changes === 0) {
              assertCommittedInvariant({
                committed_id: result.committed_id,
                id: result.id,
              });
            }
          }
        }

        deleteDraftByIdStmt.run({ id: result.id });
      },
    );

    applyCommittedBatchTxn = createTransaction(db, ({ events, nextCursor }) => {
      for (const event of events) {
        const insertResult = insertCommittedStmt.run({
          committed_id: event.committed_id,
          id: event.id,
          client_id: event.client_id,
          partitions: JSON.stringify(event.partitions),
          event: JSON.stringify(event.event),
          status_updated_at: event.status_updated_at,
        });

        if (insertResult.changes === 0) {
          assertCommittedInvariant(event);
        }

        deleteDraftByIdStmt.run({ id: event.id });
      }

      if (nextCursor !== undefined) {
        saveCursorMonotonic(nextCursor);
      }
    });
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

    loadCursor: async () => {
      ensureInitialized();
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      ensureInitialized();
      insertDraftStmt.run({
        id,
        client_id: clientId,
        partitions: JSON.stringify(partitions),
        event: JSON.stringify(event),
        created_at: createdAt,
      });
    },

    loadDraftsOrdered: async () => {
      ensureInitialized();
      return listDraftsStmt.all().map(parseDraft);
    },

    applySubmitResult: async ({ result, fallbackClientId }) => {
      ensureInitialized();
      applySubmitResultTxn({ result, fallbackClientId });
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      ensureInitialized();
      applyCommittedBatchTxn({ events, nextCursor });
    },
  };
};

// Backwards-compatible alias used by examples/docs.
export const createSqliteStore = createSqliteClientStore;
