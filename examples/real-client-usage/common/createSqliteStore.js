// Example store adapter for better-sqlite3 style DB objects.
// This keeps the 2-table model: local_drafts + committed_events.

export function createSqliteStore(db) {
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
    ...row,
    partitions: JSON.parse(row.partitions),
    event: JSON.parse(row.event),
  });

  const parseIntSafe = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return {
    init: async () => {
      runSchema();
    },

    loadCursor: async () => {
      const row = loadCursorStmt.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    saveCursor: async (committedId) => {
      saveCursorStmt.run({ value: String(committedId) });
    },

    insertDraft: async ({ id, client_id, partitions, event, created_at }) => {
      insertDraftStmt.run({
        id,
        client_id,
        partitions: JSON.stringify(partitions),
        event: JSON.stringify(event),
        created_at,
      });

      const row = getDraftByIdStmt.get({ id });
      return parseDraft(row);
    },

    loadDraftsOrdered: async () => listDraftsStmt.all().map(parseDraft),

    getDraftById: async (id) => {
      const row = getDraftByIdStmt.get({ id });
      return row ? parseDraft(row) : null;
    },

    removeDraftById: async (id) => {
      deleteDraftByIdStmt.run({ id });
    },

    applyCommitted: async ({
      committed_id,
      id,
      client_id,
      partitions,
      event,
      status_updated_at,
    }) => {
      insertCommittedStmt.run({
        committed_id,
        id,
        client_id,
        partitions: JSON.stringify(partitions),
        event: JSON.stringify(event),
        status_updated_at,
      });
    },
  };
}
