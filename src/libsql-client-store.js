import { canonicalizeSubmitItem } from "./canonicalize.js";
import { buildCommittedEventFromDraft, normalizeMeta } from "./event-record.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";

const SCHEMA_VERSION = 1;
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 512;

const toSerializedJson = (value) => JSON.stringify(value);

const parseDraft = (row) => ({
  draftClock: parseIntSafe(row.draft_clock, 0),
  id: row.id,
  partitions: JSON.parse(row.partitions),
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  type: row.type,
  payload: JSON.parse(row.payload),
  meta: normalizeMeta(JSON.parse(row.meta)),
  createdAt: parseIntSafe(row.created_at, 0),
});

const parseCommittedRow = (row) => ({
  committedId: parseIntSafe(row.committed_id, 0),
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partitions: JSON.parse(row.partitions),
  type: row.type,
  payload: JSON.parse(row.payload),
  meta: normalizeMeta(JSON.parse(row.meta)),
  created: parseIntSafe(row.created, 0),
});

const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);

const toComparisonKey = (event) =>
  canonicalizeSubmitItem({
    partitions: event.partitions,
    projectId: event.projectId,
    userId: event.userId,
    type: event.type,
    payload: event.payload,
    meta: event.meta,
  });

export const createLibsqlClientStore = (
  client,
  {
    applyPragmas = false,
    journalMode = "WAL",
    synchronous = "FULL",
    busyTimeoutMs = 5000,
    materializedViews,
    materializedBackfillChunkSize = DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE,
  } = {},
) => {
  const db = createLibsqlDriver(client);
  let initialized = false;
  /** @type {null|Promise<void>} */
  let initPromise = null;
  let materializedViewRuntime;

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

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

  const migrations = [
    async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS local_drafts (
          draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          partitions TEXT NOT NULL,
          project_id TEXT,
          user_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          meta TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS committed_events (
          committed_id INTEGER PRIMARY KEY,
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
      await db.execute(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS materialized_view_state (
          view_name TEXT NOT NULL,
          partition TEXT NOT NULL,
          view_version TEXT NOT NULL,
          last_committed_id INTEGER NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(view_name, partition)
        );
      `);
    },
  ];

  const runMigrations = async () => {
    let current = await getUserVersion();
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
      await migrate();
      await setUserVersion(next);
      current = next;
    }
  };

  const assertCommittedInvariant = async (event) => {
    const byId = await db.queryOne(
      `
        SELECT committed_id, id, project_id, user_id, partitions, type, payload, meta, created
        FROM committed_events
        WHERE id = ?
      `,
      [event.id],
    );
    if (byId) {
      const parsedById = parseCommittedRow(byId);
      if (
        parsedById.committedId !== event.committedId ||
        toComparisonKey(parsedById) !== toComparisonKey(event)
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
    }

    const byCommittedId = await db.queryOne(
      `
        SELECT committed_id, id
        FROM committed_events
        WHERE committed_id = ?
      `,
      [event.committedId],
    );
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${event.committedId}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = async (nextCursor) => {
    await db.execute(
      `
        INSERT INTO app_state(key, value)
        VALUES('cursor_committed_id', ?)
        ON CONFLICT(key) DO UPDATE
        SET value = CAST(
          MAX(CAST(app_state.value AS INTEGER), CAST(excluded.value AS INTEGER))
          AS TEXT
        )
      `,
      [String(nextCursor)],
    );
  };

  const createRuntime = () =>
    createMaterializedViewRuntime({
      definitions: materializedViewDefinitions,
      chunkSize: materializedBackfillChunkSize,
      getLatestCommittedId: async () => {
        const row = await db.queryOne(
          `
            SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
            FROM committed_events
          `,
        );
        return parseIntSafe(row?.max_committed_id, 0);
      },
      listCommittedAfter: async ({ sinceCommittedId, limit }) => {
        const rows = await db.queryAll(
          `
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
            WHERE committed_id > ?
            ORDER BY committed_id ASC
            LIMIT ?
          `,
          [sinceCommittedId, limit],
        );
        return rows.map(parseCommittedRow);
      },
      loadCheckpoint: async ({ viewName, partition }) => {
        const row = await db.queryOne(
          `
            SELECT view_version, last_committed_id, value, updated_at
            FROM materialized_view_state
            WHERE view_name = ? AND partition = ?
          `,
          [viewName, partition],
        );
        if (!row) return undefined;
        return {
          viewVersion: row.view_version,
          lastCommittedId: parseIntSafe(row.last_committed_id, 0),
          value: JSON.parse(row.value),
          updatedAt: parseIntSafe(row.updated_at, 0),
        };
      },
      saveCheckpoint: async ({
        viewName,
        viewVersion,
        partition,
        value,
        lastCommittedId,
        updatedAt,
      }) => {
        await db.execute(
          `
            INSERT INTO materialized_view_state(
              view_name,
              partition,
              view_version,
              last_committed_id,
              value,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(view_name, partition) DO UPDATE
            SET
              view_version = excluded.view_version,
              last_committed_id = excluded.last_committed_id,
              value = excluded.value,
              updated_at = excluded.updated_at
          `,
          [
            viewName,
            partition,
            viewVersion,
            lastCommittedId,
            encodeMaterializedValue(value),
            updatedAt,
          ],
        );
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        await db.execute(
          `
            DELETE FROM materialized_view_state
            WHERE view_name = ? AND partition = ?
          `,
          [viewName, partition],
        );
      },
    });

  const ensureInitialized = async () => {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await runPragmas();
      await runMigrations();
      materializedViewRuntime = createRuntime();
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

    loadCursor: async () => {
      await ensureInitialized();
      const row = await db.queryOne(
        `
          SELECT value
          FROM app_state
          WHERE key = 'cursor_committed_id'
        `,
      );
      return row ? parseIntSafe(row.value, 0) : 0;
    },

    insertDraft: async ({
      id,
      partitions,
      projectId,
      userId,
      type,
      payload,
      meta,
      createdAt,
    }) => {
      await ensureInitialized();
      await db.execute(
        `
          INSERT INTO local_drafts(
            id,
            partitions,
            project_id,
            user_id,
            type,
            payload,
            meta,
            created_at
          )
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          toSerializedJson(partitions),
          projectId ?? null,
          userId ?? null,
          type,
          toSerializedJson(payload),
          toSerializedJson(normalizeMeta(meta)),
          createdAt,
        ],
      );
    },

    loadDraftsOrdered: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT draft_clock, id, partitions, project_id, user_id, type, payload, meta, created_at
        FROM local_drafts
        ORDER BY draft_clock ASC, id ASC
      `);
      return rows.map(parseDraft);
    },

    applySubmitResult: async ({ result }) => {
      await ensureInitialized();
      let committedEvent;

      if (result.status === "committed") {
        const draft = await db.queryOne(
          `
            SELECT draft_clock, id, partitions, project_id, user_id, type, payload, meta, created_at
            FROM local_drafts
            WHERE id = ?
          `,
          [result.id],
        );

        if (draft) {
          const parsedDraft = parseDraft(draft);
          const nextCommittedEvent = buildCommittedEventFromDraft({
            draft: parsedDraft,
            committedId: result.committedId,
            created: result.created,
          });
          const insertResult = await db.execute(
            `
              INSERT OR IGNORE INTO committed_events(
                committed_id,
                id,
                project_id,
                user_id,
                partitions,
                type,
                payload,
                meta,
                created
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              nextCommittedEvent.committedId,
              nextCommittedEvent.id,
              nextCommittedEvent.projectId ?? null,
              nextCommittedEvent.userId ?? null,
              toSerializedJson(nextCommittedEvent.partitions),
              nextCommittedEvent.type,
              toSerializedJson(nextCommittedEvent.payload),
              toSerializedJson(nextCommittedEvent.meta),
              nextCommittedEvent.created,
            ],
          );

          if (db.rowsAffected(insertResult) === 0) {
            await assertCommittedInvariant(nextCommittedEvent);
          } else {
            committedEvent = nextCommittedEvent;
          }
        }
      }

      await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);

      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await ensureInitialized();

      const insertedEvents = [];
      for (const event of events) {
        const insertResult = await db.execute(
          `
            INSERT OR IGNORE INTO committed_events(
              committed_id,
              id,
              project_id,
              user_id,
              partitions,
              type,
              payload,
              meta,
              created
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            event.committedId,
            event.id,
            event.projectId ?? null,
            event.userId ?? null,
            toSerializedJson(event.partitions),
            event.type,
            toSerializedJson(event.payload),
            toSerializedJson(normalizeMeta(event.meta)),
            event.created,
          ],
        );

        if (db.rowsAffected(insertResult) === 0) {
          await assertCommittedInvariant(event);
        } else {
          insertedEvents.push({
            ...event,
            payload: structuredClone(event.payload),
            meta: normalizeMeta(event.meta),
          });
        }

        await db.execute(`DELETE FROM local_drafts WHERE id = ?`, [event.id]);
      }

      if (nextCursor !== undefined) {
        await saveCursorMonotonic(nextCursor);
      }

      for (const event of insertedEvents) {
        await materializedViewRuntime.onCommittedEvent(event);
      }
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      return materializedViewRuntime.loadMaterializedView({
        viewName,
        partition,
      });
    },

    loadMaterializedViews: async ({ viewName, partitions }) => {
      await ensureInitialized();
      return materializedViewRuntime.loadMaterializedViews({
        viewName,
        partitions,
      });
    },

    evictMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.evictMaterializedView({
        viewName,
        partition,
      });
    },

    invalidateMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      await materializedViewRuntime.invalidateMaterializedView({
        viewName,
        partition,
      });
    },

    flushMaterializedViews: async () => {
      await ensureInitialized();
      await materializedViewRuntime.flushMaterializedViews();
    },

    _debug: {
      getDrafts: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT draft_clock, id, partitions, project_id, user_id, type, payload, meta, created_at
          FROM local_drafts
          ORDER BY draft_clock ASC, id ASC
        `);
        return rows.map(parseDraft);
      },
      getCommitted: async () => {
        await ensureInitialized();
        const rows = await db.queryAll(`
          SELECT committed_id, id, project_id, user_id, partitions, type, payload, meta, created
          FROM committed_events
          ORDER BY committed_id ASC
        `);
        return rows.map(parseCommittedRow);
      },
      getCursor: async () => {
        await ensureInitialized();
        const row = await db.queryOne(
          `
            SELECT value
            FROM app_state
            WHERE key = 'cursor_committed_id'
          `,
        );
        return row ? parseIntSafe(row.value, 0) : 0;
      },
    },
  };
};

export const createLibsqlStore = createLibsqlClientStore;
