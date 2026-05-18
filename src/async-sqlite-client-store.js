import { parseIntSafe } from "./libsql-driver.js";
import { normalizeMaterializedViewDefinitions } from "./materialized-view.js";
import { createMaterializedViewRuntime } from "./materialized-view-runtime.js";
import {
  createClosedResourceError,
  throwIfClosed,
} from "./store-errors.js";
import {
  buildStoredCommittedFromDraft,
  getStoredCommittedId,
  parseStoredEvent,
  parseStoredPartitions,
  toStoredCommitted,
  toStoredComparisonKey,
  toStoredDraft,
  withStoredCommittedAliases,
  withStoredDraftAliases,
} from "./stored-event.js";

const SCHEMA_VERSION = 7;
const DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE = 512;

const parseDraft = (row) =>
  withStoredDraftAliases({
    draftClock: parseIntSafe(row.draft_clock, 0),
    id: row.id,
    clientId: row.client_id,
    partitions: parseStoredPartitions(row.partitions),
    event: parseStoredEvent(row.event),
    createdAt: parseIntSafe(row.created_at, 0),
  });

const parseCommittedRow = (row) =>
  withStoredCommittedAliases({
    committed_id: parseIntSafe(row.committed_id, 0),
    id: row.id,
    client_id: row.client_id,
    partitions: parseStoredPartitions(row.partitions),
    event: parseStoredEvent(row.event),
    status_updated_at: parseIntSafe(row.status_updated_at, 0),
  });

const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);

const toComparisonKey = (event) => toStoredComparisonKey(event);

const normalizeExecuteResult = (result) => ({
  rowsAffected: parseIntSafe(result?.rowsAffected ?? result?.changes ?? 0, 0),
  lastInsertRowId: result?.lastInsertRowId ?? result?.lastInsertRowid,
});

const normalizeTransaction = (transaction) => {
  if (
    !transaction ||
    typeof transaction.query !== "function" ||
    typeof transaction.execute !== "function"
  ) {
    throw new Error(
      "async sqlite driver transaction requires query(sql, args?) and execute(sql, args?)",
    );
  }

  return {
    query: async (sql, args = []) => {
      const rows = await transaction.query(sql, args);
      if (!Array.isArray(rows)) {
        throw new Error("async sqlite driver query must return an array of rows");
      }
      return rows;
    },
    execute: async (sql, args = []) =>
      normalizeExecuteResult(await transaction.execute(sql, args)),
  };
};

const tableHasColumn = async (tx, tableName, columnName) => {
  const rows = await tx.query(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
};

const getTableColumnType = async (tx, tableName, columnName) => {
  const rows = await tx.query(`PRAGMA table_info(${tableName})`);
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

const ensureMaterializedViewStateCheckpointColumns = async (tx) => {
  if (!(await tableHasColumn(tx, "materialized_view_state", "view_version"))) {
    await tx.execute(
      "ALTER TABLE materialized_view_state ADD COLUMN view_version TEXT",
    );
  }
  if (
    !(await tableHasColumn(
      tx,
      "materialized_view_state",
      "last_committed_id",
    ))
  ) {
    await tx.execute(
      "ALTER TABLE materialized_view_state ADD COLUMN last_committed_id INTEGER",
    );
  }
};

/**
 * @param {{
 *   driver: {
 *     init?: () => Promise<void>,
 *     transaction: <T>(
 *       mode: "read" | "write",
 *       run: (tx: {
 *         query: (sql: string, args?: Array<null|string|number|Uint8Array|ArrayBuffer>) => Promise<object[]>,
 *         execute: (
 *           sql: string,
 *           args?: Array<null|string|number|Uint8Array|ArrayBuffer>,
 *         ) => Promise<{ rowsAffected: number, lastInsertRowId?: number|string }>
 *       }) => Promise<T>,
 *     ) => Promise<T>,
 *     close?: () => Promise<void>,
 *   },
 *   applyPragmas?: boolean,
 *   journalMode?: string,
 *   synchronous?: string,
 *   busyTimeoutMs?: number,
 *   materializedViews?: object[],
 *   materializedBackfillChunkSize?: number,
 * }} input
 */
export const createAsyncSqliteClientStore = ({
  driver,
  applyPragmas = false,
  journalMode = "WAL",
  synchronous = "FULL",
  busyTimeoutMs = 5000,
  materializedViews,
  materializedBackfillChunkSize = DEFAULT_MATERIALIZED_BACKFILL_CHUNK_SIZE,
} = {}) => {
  if (!driver || typeof driver.transaction !== "function") {
    throw new Error(
      "createAsyncSqliteClientStore requires a driver with transaction(mode, run)",
    );
  }

  let initialized = false;
  let closing = false;
  let closed = false;
  let initPromise = null;
  let closePromise = null;
  let materializedViewRuntime;
  let activeOperationCount = 0;
  let idleResolver;
  let writeTail = Promise.resolve();

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

  const ensureNotClosed = () => {
    throwIfClosed(closed, "async sqlite client store", "client_store_closed");
  };

  const ensureAvailable = () => {
    ensureNotClosed();
    if (closing) {
      throw createClosedResourceError(
        "async sqlite client store",
        "client_store_closed",
      );
    }
  };

  const beginOperation = () => {
    activeOperationCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeOperationCount -= 1;
      if (activeOperationCount === 0 && idleResolver) {
        const resolve = idleResolver;
        idleResolver = undefined;
        resolve();
      }
    };
  };

  const waitForIdle = async () => {
    if (activeOperationCount === 0) return;
    await new Promise((resolve) => {
      idleResolver = resolve;
    });
  };

  const runTransaction = async (mode, run) => {
    ensureNotClosed();
    const finishOperation = beginOperation();
    try {
      return await driver.transaction(mode, async (rawTransaction) =>
        run(normalizeTransaction(rawTransaction)),
      );
    } finally {
      finishOperation();
    }
  };

  const runInternalRead = async (run) => runTransaction("read", run);

  const runInternalWrite = async (run) => {
    const operation = writeTail.catch(() => {}).then(() => runTransaction("write", run));
    writeTail = operation.catch(() => {});
    return operation;
  };

  const runRead = async (run) => {
    ensureAvailable();
    return runInternalRead(run);
  };

  const runWrite = async (run) => {
    ensureAvailable();
    return runInternalWrite(run);
  };

  const runPragmas = async (tx) => {
    if (!applyPragmas) return;
    await tx.execute(`PRAGMA journal_mode=${journalMode}`);
    await tx.execute(`PRAGMA synchronous=${synchronous}`);
    if (Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0) {
      await tx.execute(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    }
  };

  const getUserVersion = async (tx) => {
    const rows = await tx.query("PRAGMA user_version");
    return parseIntSafe(rows[0]?.user_version, 0);
  };

  const setUserVersion = async (tx, version) => {
    await tx.execute(`PRAGMA user_version=${version}`);
  };

  const createMaterializedSchema = async (tx) => {
    await tx.execute(`
      CREATE TABLE IF NOT EXISTS materialized_view_state (
        view_name TEXT NOT NULL,
        partition TEXT NOT NULL,
        view_version TEXT,
        last_committed_id INTEGER,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(view_name, partition)
      )
    `);
    await ensureMaterializedViewStateCheckpointColumns(tx);
    await tx.execute(`
      CREATE TABLE IF NOT EXISTS materialized_view_offsets (
        view_name TEXT PRIMARY KEY,
        view_version TEXT NOT NULL,
        last_committed_id INTEGER NOT NULL
      )
    `);
  };

  const createSchema = async (tx) => {
    await tx.execute(`
      CREATE TABLE IF NOT EXISTS local_drafts (
        draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    await tx.execute(`
      CREATE TABLE IF NOT EXISTS committed_events (
        committed_id INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        partitions TEXT NOT NULL,
        event TEXT NOT NULL,
        status_updated_at INTEGER NOT NULL
      )
    `);
    await tx.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await createMaterializedSchema(tx);
  };

  const validateSchema = async (tx) => {
    const hasDraftClientId = await tableHasColumn(tx, "local_drafts", "client_id");
    const hasDraftPartitions = await tableHasColumn(
      tx,
      "local_drafts",
      "partitions",
    );
    const hasDraftEvent = await tableHasColumn(tx, "local_drafts", "event");
    const hasCommittedClientId = await tableHasColumn(
      tx,
      "committed_events",
      "client_id",
    );
    const hasCommittedPartitions = await tableHasColumn(
      tx,
      "committed_events",
      "partitions",
    );
    const hasCommittedEvent = await tableHasColumn(tx, "committed_events", "event");
    const hasCommittedStatusUpdatedAt = await tableHasColumn(
      tx,
      "committed_events",
      "status_updated_at",
    );
    const draftEventType = await getTableColumnType(tx, "local_drafts", "event");
    const committedEventType = await getTableColumnType(tx, "committed_events", "event");
    if (
      !hasDraftClientId ||
      !hasDraftPartitions ||
      !hasDraftEvent ||
      !hasCommittedClientId ||
      !hasCommittedPartitions ||
      !hasCommittedEvent ||
      !hasCommittedStatusUpdatedAt ||
      draftEventType !== "TEXT" ||
      committedEventType !== "TEXT"
    ) {
      throw new Error("Client store schema is incompatible; reset required");
    }
  };

  const initializeSchema = async () => {
    const current = await runInternalWrite(async (tx) => {
      await runPragmas(tx);
      const nextCurrent = await getUserVersion(tx);
      if (nextCurrent > SCHEMA_VERSION) {
        throw new Error(
          `Unsupported schema version ${nextCurrent}; runtime supports up to ${SCHEMA_VERSION}`,
        );
      }

      if (nextCurrent === 0) {
        await createSchema(tx);
        await validateSchema(tx);
        await setUserVersion(tx, SCHEMA_VERSION);
        return SCHEMA_VERSION;
      }

      if (nextCurrent < SCHEMA_VERSION) {
        await createMaterializedSchema(tx);
        await validateSchema(tx);
        await setUserVersion(tx, SCHEMA_VERSION);
        return SCHEMA_VERSION;
      }

      await createMaterializedSchema(tx);
      return nextCurrent;
    });

    if (current !== SCHEMA_VERSION) {
      throw new Error(
        `Client store requires reset for schema version ${current}; runtime expects ${SCHEMA_VERSION}`,
      );
    }

    await runInternalRead(async (tx) => {
      await validateSchema(tx);
    });
  };

  const assertCommittedInvariant = async (tx, event) => {
    const byIdRows = await tx.query(
      `
        SELECT committed_id, id, client_id, partitions, event, status_updated_at
        FROM committed_events
        WHERE id = ?
      `,
      [event.id],
    );
    const byId = byIdRows[0];
    if (byId) {
      const parsedById = parseCommittedRow(byId);
      if (
        parsedById.committed_id !== getStoredCommittedId(event) ||
        toComparisonKey(parsedById) !== toComparisonKey(event)
      ) {
        throw new Error(
          `committed event invariant violation for id ${event.id}: conflicting duplicate`,
        );
      }
    }

    const byCommittedIdRows = await tx.query(
      `
        SELECT committed_id, id
        FROM committed_events
        WHERE committed_id = ?
      `,
      [getStoredCommittedId(event)],
    );
    const byCommittedId = byCommittedIdRows[0];
    if (byCommittedId && byCommittedId.id !== event.id) {
      throw new Error(
        `committed event invariant violation for committedId ${getStoredCommittedId(event)}: id mismatch`,
      );
    }
  };

  const saveCursorMonotonic = async (tx, nextCursor) => {
    await tx.execute(
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
      getLatestCommittedId: async () =>
        runInternalRead(async (tx) => {
          const rows = await tx.query(
            `
              SELECT COALESCE(MAX(committed_id), 0) AS max_committed_id
              FROM committed_events
            `,
          );
          return parseIntSafe(rows[0]?.max_committed_id, 0);
        }),
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        runInternalRead(async (tx) => {
          const rows = await tx.query(
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
            [sinceCommittedId, limit],
          );
          return rows.map(parseCommittedRow);
        }),
      loadCheckpoint: async ({ viewName, partition }) =>
        runInternalRead(async (tx) => {
          const rows = await tx.query(
            `
              SELECT value, updated_at, view_version, last_committed_id
              FROM materialized_view_state
              WHERE view_name = ? AND partition = ?
            `,
            [viewName, partition],
          );
          const row = rows[0];
          if (!row) return undefined;
          const offsetRows = await tx.query(
            `
              SELECT view_name, view_version, last_committed_id
              FROM materialized_view_offsets
              WHERE view_name = ?
            `,
            [viewName],
          );
          const offset = offsetRows[0];
          if (row.last_committed_id === null || row.last_committed_id === undefined) {
            return undefined;
          }
          return {
            viewVersion: row.view_version ?? offset?.view_version,
            lastCommittedId: parseIntSafe(row.last_committed_id, 0),
            value: JSON.parse(row.value),
            updatedAt: parseIntSafe(row.updated_at, 0),
          };
        }),
      saveCheckpoint: async ({
        viewName,
        viewVersion,
        partition,
        value,
        lastCommittedId,
        updatedAt,
      }) => {
        await runInternalWrite(async (tx) => {
          await tx.execute(
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
          await tx.execute(
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
            [viewName, viewVersion, lastCommittedId],
          );
        });
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        await runInternalWrite(async (tx) => {
          await tx.execute(
            `
              DELETE FROM materialized_view_state
              WHERE view_name = ? AND partition = ?
            `,
            [viewName, partition],
          );
        });
      },
    });

  const ensureInitialized = async () => {
    ensureAvailable();
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (typeof driver.init === "function") {
        await driver.init();
      }
      await initializeSchema();
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

    close: async () => {
      if (closePromise) return closePromise;

      closePromise = (async () => {
        closing = true;

        if (initPromise) {
          await initPromise.catch(() => {});
        }

        await writeTail.catch(() => {});

        if (materializedViewRuntime) {
          await materializedViewRuntime.flushMaterializedViews();
          await materializedViewRuntime.close();
        }

        await writeTail.catch(() => {});
        await waitForIdle();

        closed = true;
        closing = false;

        if (typeof driver.close === "function") {
          await driver.close();
        }
      })();

      return closePromise;
    },

    loadCursor: async () => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(
          `
            SELECT value
            FROM app_state
            WHERE key = 'cursor_committed_id'
          `,
        );
        const row = rows[0];
        return row ? parseIntSafe(row.value, 0) : 0;
      });
    },

    getCursor: async () => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(
          `
            SELECT value
            FROM app_state
            WHERE key = 'cursor_committed_id'
          `,
        );
        const row = rows[0];
        return row ? parseIntSafe(row.value, 0) : 0;
      });
    },

    insertDraft: async (item) => {
      await ensureInitialized();
      await runWrite(async (tx) => {
        const draft = toStoredDraft(item);
        await tx.execute(
          `
            INSERT INTO local_drafts(
              id,
              client_id,
              partitions,
              event,
              created_at
            )
            VALUES(?, ?, ?, ?, ?)
          `,
          [
            draft.id,
            draft.clientId || "unknown",
            JSON.stringify(draft.partitions),
            JSON.stringify(draft.event),
            draft.createdAt,
          ],
        );
      });
    },

    insertDrafts: async (items) => {
      await ensureInitialized();
      await runWrite(async (tx) => {
        for (const item of items) {
          const draft = toStoredDraft(item);
          await tx.execute(
            `
              INSERT INTO local_drafts(
                id,
                client_id,
                partitions,
                event,
                created_at
              )
              VALUES(?, ?, ?, ?, ?)
            `,
            [
              draft.id,
              draft.clientId || "unknown",
              JSON.stringify(draft.partitions),
              JSON.stringify(draft.event),
              draft.createdAt,
            ],
          );
        }
      });
    },

    loadDraftsOrdered: async () => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(`
          SELECT draft_clock, id, client_id, partitions, event, created_at
          FROM local_drafts
          ORDER BY draft_clock ASC, id ASC
        `);
        return rows.map(parseDraft);
      });
    },

    listDraftsOrdered: async () => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(`
          SELECT draft_clock, id, client_id, partitions, event, created_at
          FROM local_drafts
          ORDER BY draft_clock ASC, id ASC
        `);
        return rows.map(parseDraft);
      });
    },

    applySubmitResult: async ({ result }) => {
      await ensureInitialized();
      const committedEvent = await runWrite(async (tx) => {
        let nextCommittedEvent;

        if (result.status === "committed") {
          const draftRows = await tx.query(
            `
              SELECT draft_clock, id, client_id, partitions, event, created_at
              FROM local_drafts
              WHERE id = ?
            `,
            [result.id],
          );
          const draftRow = draftRows[0];

          if (draftRow) {
            const parsedDraft = parseDraft(draftRow);
            const committedRecord = buildStoredCommittedFromDraft({
              draft: parsedDraft,
              result,
            });
            const insertResult = await tx.execute(
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
                committedRecord.committed_id,
                committedRecord.id,
                committedRecord.client_id || "unknown",
                JSON.stringify(committedRecord.partitions),
                JSON.stringify(committedRecord.event),
                committedRecord.status_updated_at,
              ],
            );

            if (insertResult.rowsAffected === 0) {
              await assertCommittedInvariant(tx, committedRecord);
            } else {
              nextCommittedEvent = committedRecord;
            }
          }

          await tx.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
        } else if (result.status === "rejected") {
          await tx.execute(`DELETE FROM local_drafts WHERE id = ?`, [result.id]);
        }

        return nextCommittedEvent;
      });

      if (committedEvent) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      await ensureInitialized();
      const insertedEvents = await runWrite(async (tx) => {
        const nextInsertedEvents = [];
        for (const event of events) {
          const committedRecord = toStoredCommitted(event);
          const insertResult = await tx.execute(
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
              committedRecord.committed_id,
              committedRecord.id,
              committedRecord.client_id || "unknown",
              JSON.stringify(committedRecord.partitions),
              JSON.stringify(committedRecord.event),
              committedRecord.status_updated_at,
            ],
          );

          if (insertResult.rowsAffected === 0) {
            await assertCommittedInvariant(tx, committedRecord);
          } else {
            nextInsertedEvents.push(committedRecord);
          }

          await tx.execute(`DELETE FROM local_drafts WHERE id = ?`, [event.id]);
        }

        if (nextCursor !== undefined) {
          await saveCursorMonotonic(tx, nextCursor);
        }

        return nextInsertedEvents;
      });

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

    subscribeMaterializedView: async ({
      viewName,
      partition,
      onChange,
      emitCurrent,
    }) => {
      await ensureInitialized();
      return materializedViewRuntime.subscribeMaterializedView({
        viewName,
        partition,
        onChange,
        emitCurrent,
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

    listCommitted: async () => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(`
          SELECT committed_id, id, client_id, partitions, event, status_updated_at
          FROM committed_events
          ORDER BY committed_id ASC
        `);
        return rows.map(parseCommittedRow);
      });
    },

    listCommittedAfter: async ({
      sinceCommittedId = 0,
      limit = Number.MAX_SAFE_INTEGER,
    } = {}) => {
      await ensureInitialized();
      return runRead(async (tx) => {
        const rows = await tx.query(
          `
            SELECT committed_id, id, client_id, partitions, event, status_updated_at
            FROM committed_events
            WHERE committed_id > ?
            ORDER BY committed_id ASC
            LIMIT ?
          `,
          [sinceCommittedId, limit],
        );
        return rows.map(parseCommittedRow);
      });
    },

    _debug: {
      getDrafts: async () => {
        await ensureInitialized();
        return runRead(async (tx) => {
          const rows = await tx.query(`
            SELECT draft_clock, id, client_id, partitions, event, created_at
            FROM local_drafts
            ORDER BY draft_clock ASC, id ASC
          `);
          return rows.map(parseDraft);
        });
      },
      getCommitted: async () => {
        await ensureInitialized();
        return runRead(async (tx) => {
          const rows = await tx.query(`
            SELECT committed_id, id, client_id, partitions, event, status_updated_at
            FROM committed_events
            ORDER BY committed_id ASC
          `);
          return rows.map(parseCommittedRow);
        });
      },
      getCursor: async () => {
        await ensureInitialized();
        return runRead(async (tx) => {
          const rows = await tx.query(
            `
              SELECT value
              FROM app_state
              WHERE key = 'cursor_committed_id'
            `,
          );
          const row = rows[0];
          return row ? parseIntSafe(row.value, 0) : 0;
        });
      },
    },
  };
};

export const createAsyncSqliteStore = createAsyncSqliteClientStore;
