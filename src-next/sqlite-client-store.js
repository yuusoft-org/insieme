// SQLite adapter for the simplified client store interface.
// Expects a better-sqlite3 style DB object (exec/prepare/transaction APIs).

export const createSqliteClientStore = (db) => {
  const runSchema = () => {
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

      CREATE INDEX IF NOT EXISTS local_drafts_order
        ON local_drafts(draft_clock, id);

      CREATE INDEX IF NOT EXISTS committed_events_order
        ON committed_events(committed_id);
    `);
  };

  const loadCursorStmt = db.prepare(
    `SELECT value FROM app_state WHERE key = 'cursor_committed_id'`,
  );
  const saveCursorStmt = db.prepare(`
    INSERT INTO app_state(key, value)
    VALUES('cursor_committed_id', @value)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);

  const insertDraftStmt = db.prepare(`
    INSERT INTO local_drafts(id, client_id, partitions, event, created_at)
    VALUES(@id, @client_id, @partitions, @event, @created_at)
  `);
  const listDraftsStmt = db.prepare(`
    SELECT draft_clock, id, client_id, partitions, event, created_at
    FROM local_drafts
    ORDER BY draft_clock ASC, id ASC
  `);
  const getDraftByIdStmt = db.prepare(`
    SELECT draft_clock, id, client_id, partitions, event, created_at
    FROM local_drafts
    WHERE id = @id
  `);
  const deleteDraftByIdStmt = db.prepare(`
    DELETE FROM local_drafts WHERE id = @id
  `);

  const insertCommittedStmt = db.prepare(`
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

  const parseDraft = (row) => ({
    draftClock: row.draft_clock,
    id: row.id,
    clientId: row.client_id,
    partitions: JSON.parse(row.partitions),
    event: JSON.parse(row.event),
    createdAt: row.created_at,
  });

  const parseIntSafe = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const applySubmitResultTxn = db.transaction(({ result, fallbackClientId }) => {
    if (result.status === "committed") {
      const draft = getDraftByIdStmt.get({ id: result.id });

      if (draft) {
        insertCommittedStmt.run({
          committed_id: result.committed_id,
          id: result.id,
          client_id: draft.client_id || fallbackClientId,
          partitions: draft.partitions,
          event: draft.event,
          status_updated_at: result.status_updated_at,
        });
      }
    }

    deleteDraftByIdStmt.run({ id: result.id });
  });

  const applyCommittedBatchTxn = db.transaction(({ events, nextCursor }) => {
    for (const event of events) {
      insertCommittedStmt.run({
        committed_id: event.committed_id,
        id: event.id,
        client_id: event.client_id,
        partitions: JSON.stringify(event.partitions),
        event: JSON.stringify(event.event),
        status_updated_at: event.status_updated_at,
      });

      deleteDraftByIdStmt.run({ id: event.id });
    }

    if (nextCursor !== undefined) {
      saveCursorStmt.run({ value: String(nextCursor) });
    }
  });

  return {
    init: async () => {
      runSchema();
    },

    loadCursor: async () => {
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      insertDraftStmt.run({
        id,
        client_id: clientId,
        partitions: JSON.stringify(partitions),
        event: JSON.stringify(event),
        created_at: createdAt,
      });
    },

    loadDraftsOrdered: async () => listDraftsStmt.all().map(parseDraft),

    applySubmitResult: async ({ result, fallbackClientId }) => {
      applySubmitResultTxn({ result, fallbackClientId });
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      applyCommittedBatchTxn({ events, nextCursor });
    },
  };
};

// Backwards-compatible alias used by examples/docs.
export const createSqliteStore = createSqliteClientStore;
