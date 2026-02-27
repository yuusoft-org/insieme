import {
  applyMaterializedViewReducer,
  cloneMaterializedViewValue,
  createMaterializedViewInitialState,
  normalizeMaterializedViewDefinitions,
} from "./materialized-view.js";
import { createLibsqlDriver, parseIntSafe } from "./libsql-driver.js";

const SCHEMA_VERSION = 2;
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 512;

const toSerializedJson = (value) => JSON.stringify(value);

const parseDraft = (row) => ({
  draftClock: parseIntSafe(row.draft_clock, 0),
  id: row.id,
  clientId: row.client_id,
  partitions: JSON.parse(row.partitions),
  event: JSON.parse(row.event),
  createdAt: parseIntSafe(row.created_at, 0),
});

const parseCommittedRow = (row) => ({
  committed_id: parseIntSafe(row.committed_id, 0),
  id: row.id,
  client_id: row.client_id,
  partitions: JSON.parse(row.partitions),
  event: JSON.parse(row.event),
  status_updated_at: parseIntSafe(row.status_updated_at, 0),
});

const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);

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

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);
  const materializedDefinitionByName = new Map(
    materializedViewDefinitions.map((definition) => [
      definition.name,
      definition,
    ]),
  );

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
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS committed_events (
          committed_id INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          partitions TEXT NOT NULL,
          event TEXT NOT NULL,
          status_updated_at INTEGER NOT NULL
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
    async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS materialized_view_state (
          view_name TEXT NOT NULL,
          partition TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(view_name, partition)
        );
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS materialized_view_offsets (
          view_name TEXT PRIMARY KEY,
          view_version TEXT NOT NULL,
          last_committed_id INTEGER NOT NULL
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
        SELECT committed_id, id
        FROM committed_events
        WHERE id = ?
      `,
      [event.id],
    );
    if (byId && parseIntSafe(byId.committed_id, 0) !== event.committed_id) {
      throw new Error(
        `committed event invariant violation for id ${event.id}: committed_id mismatch`,
      );
    }

    const byCommittedId = await db.queryOne(
      `
        SELECT committed_id, id
        FROM committed_events
        WHERE committed_id = ?
      `,
      [event.committed_id],
    );
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committed_id ${event.committed_id}: id mismatch`,
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

  const getMaterializedDefinition = (viewName) => {
    const definition = materializedDefinitionByName.get(viewName);
    if (!definition) {
      throw new Error(`unknown materialized view '${viewName}'`);
    }
    return definition;
  };

  const loadMaterializedPartitionState = async (definition, partition) => {
    const row = await db.queryOne(
      `
        SELECT value
        FROM materialized_view_state
        WHERE view_name = ? AND partition = ?
      `,
      [definition.name, partition],
    );
    if (!row) {
      return createMaterializedViewInitialState(definition, partition);
    }
    return JSON.parse(row.value);
  };

  const saveMaterializedPartitionState = async (
    definition,
    partition,
    value,
    updatedAt,
  ) => {
    await db.execute(
      `
        INSERT INTO materialized_view_state(
          view_name,
          partition,
          value,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(view_name, partition) DO UPDATE
        SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      [definition.name, partition, encodeMaterializedValue(value), updatedAt],
    );
  };

  const saveMaterializedOffsetMonotonic = async (definition, nextCommittedId) => {
    await db.execute(
      `
        INSERT INTO materialized_view_offsets(
          view_name,
          view_version,
          last_committed_id
        ) VALUES (?, ?, ?)
        ON CONFLICT(view_name) DO UPDATE
        SET
          view_version = excluded.view_version,
          last_committed_id = MAX(
            materialized_view_offsets.last_committed_id,
            excluded.last_committed_id
          )
      `,
      [definition.name, definition.version, nextCommittedId],
    );
  };

  const applyCommittedToMaterializedViews = async (committedEvent) => {
    if (materializedViewDefinitions.length === 0) return;
    for (const definition of materializedViewDefinitions) {
      for (const partition of committedEvent.partitions) {
        const current = await loadMaterializedPartitionState(
          definition,
          partition,
        );
        const next = applyMaterializedViewReducer(
          definition,
          current,
          committedEvent,
          partition,
        );
        await saveMaterializedPartitionState(
          definition,
          partition,
          next,
          committedEvent.status_updated_at,
        );
      }
      await saveMaterializedOffsetMonotonic(
        definition,
        committedEvent.committed_id,
      );
    }
  };

  const resolveMaterializedStartOffset = async (definition) => {
    const row = await db.queryOne(
      `
        SELECT view_name, view_version, last_committed_id
        FROM materialized_view_offsets
        WHERE view_name = ?
      `,
      [definition.name],
    );

    if (!row) {
      await db.execute(
        `
          INSERT INTO materialized_view_offsets(
            view_name,
            view_version,
            last_committed_id
          ) VALUES (?, ?, ?)
          ON CONFLICT(view_name) DO UPDATE
          SET
            view_version = excluded.view_version,
            last_committed_id = excluded.last_committed_id
        `,
        [definition.name, definition.version, 0],
      );
      return 0;
    }

    if (row.view_version !== definition.version) {
      await db.execute(
        `
          DELETE FROM materialized_view_state
          WHERE view_name = ?
        `,
        [definition.name],
      );
      await db.execute(
        `
          INSERT INTO materialized_view_offsets(
            view_name,
            view_version,
            last_committed_id
          ) VALUES (?, ?, ?)
          ON CONFLICT(view_name) DO UPDATE
          SET
            view_version = excluded.view_version,
            last_committed_id = excluded.last_committed_id
        `,
        [definition.name, definition.version, 0],
      );
      return 0;
    }

    return parseIntSafe(row.last_committed_id, 0);
  };

  const catchUpMaterializedViews = async () => {
    if (materializedViewDefinitions.length === 0) return;

    const chunkSize =
      Number.isInteger(materializedBackfillChunkSize) &&
      materializedBackfillChunkSize > 0
        ? materializedBackfillChunkSize
        : DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE;

    for (const definition of materializedViewDefinitions) {
      let cursor = await resolveMaterializedStartOffset(definition);

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
          [cursor, chunkSize],
        );
        if (rows.length === 0) break;

        for (const row of rows) {
          const committedEvent = parseCommittedRow(row);
          for (const partition of committedEvent.partitions) {
            const current = await loadMaterializedPartitionState(
              definition,
              partition,
            );
            const next = applyMaterializedViewReducer(
              definition,
              current,
              committedEvent,
              partition,
            );
            await saveMaterializedPartitionState(
              definition,
              partition,
              next,
              committedEvent.status_updated_at,
            );
          }
          cursor = committedEvent.committed_id;
        }

        if (rows.length < chunkSize) break;
      }

      await db.execute(
        `
          INSERT INTO materialized_view_offsets(
            view_name,
            view_version,
            last_committed_id
          ) VALUES (?, ?, ?)
          ON CONFLICT(view_name) DO UPDATE
          SET
            view_version = excluded.view_version,
            last_committed_id = excluded.last_committed_id
        `,
        [definition.name, definition.version, cursor],
      );
    }
  };

  const ensureInitialized = async () => {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await runPragmas();
      await runMigrations();
      await catchUpMaterializedViews();
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

    insertDraft: async ({ id, clientId, partitions, event, createdAt }) => {
      await ensureInitialized();
      await db.execute(
        `
          INSERT INTO local_drafts(id, client_id, partitions, event, created_at)
          VALUES(?, ?, ?, ?, ?)
        `,
        [
          id,
          clientId,
          toSerializedJson(partitions),
          toSerializedJson(event),
          createdAt,
        ],
      );
    },

    loadDraftsOrdered: async () => {
      await ensureInitialized();
      const rows = await db.queryAll(`
        SELECT draft_clock, id, client_id, partitions, event, created_at
        FROM local_drafts
        ORDER BY draft_clock ASC, id ASC
      `);
      return rows.map(parseDraft);
    },

    applySubmitResult: async ({ result, fallbackClientId }) => {
      await ensureInitialized();
      if (result.status === "committed") {
        const draft = await db.queryOne(
          `
            SELECT draft_clock, id, client_id, partitions, event, created_at
            FROM local_drafts
            WHERE id = ?
          `,
          [result.id],
        );

        if (draft) {
          const insertResult = await db.execute(
            `
              INSERT OR IGNORE INTO committed_events(
                committed_id,
                id,
                client_id,
                partitions,
                event,
                status_updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
              result.committed_id,
              result.id,
              draft.client_id || fallbackClientId,
              draft.partitions,
              draft.event,
              result.status_updated_at,
            ],
          );

          if (db.rowsAffected(insertResult) === 0) {
            await assertCommittedInvariant({
              committed_id: result.committed_id,
              id: result.id,
            });
          } else {
            await applyCommittedToMaterializedViews({
              committed_id: result.committed_id,
              id: result.id,
              client_id: draft.client_id || fallbackClientId,
              partitions: JSON.parse(draft.partitions),
              event: JSON.parse(draft.event),
              status_updated_at: result.status_updated_at,
            });
          }
        }
      }

      await db.execute("DELETE FROM local_drafts WHERE id = ?", [result.id]);
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await ensureInitialized();
      for (const event of events) {
        const insertResult = await db.execute(
          `
            INSERT OR IGNORE INTO committed_events(
              committed_id,
              id,
              client_id,
              partitions,
              event,
              status_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            event.committed_id,
            event.id,
            event.client_id,
            toSerializedJson(event.partitions),
            toSerializedJson(event.event),
            event.status_updated_at,
          ],
        );

        if (db.rowsAffected(insertResult) === 0) {
          await assertCommittedInvariant(event);
        } else {
          await applyCommittedToMaterializedViews(event);
        }

        await db.execute("DELETE FROM local_drafts WHERE id = ?", [event.id]);
      }

      if (nextCursor !== undefined) {
        await saveCursorMonotonic(nextCursor);
      }
    },

    loadMaterializedView: async ({ viewName, partition }) => {
      await ensureInitialized();
      if (typeof partition !== "string" || partition.length === 0) {
        throw new Error("loadMaterializedView requires a non-empty partition");
      }
      const definition = getMaterializedDefinition(viewName);
      const state = await loadMaterializedPartitionState(definition, partition);
      return cloneMaterializedViewValue(state);
    },
  };
};

export const createLibsqlStore = createLibsqlClientStore;
