# Storage Layer Unified Architecture Proposal

## 1. Current State Analysis

### 1.1 File Inventory (5,303 lines total)

| File | Lines | Role |
|------|-------|------|
| `async-sqlite-client-store.js` | 978 | Async driver adapter (Tauri/tauri-plugin-sql) |
| `sqlite-client-store.js` | 788 | Synchronous better-sqlite3 adapter |
| `libsql-client-store.js` | 821 | LibSQL/Turso remote adapter |
| `indexeddb-client-store.js` | 742 | Browser IndexedDB adapter |
| `in-memory-client-store.js` | 336 | In-memory reference implementation |
| `persisted-cursor-client-store.js` | 90 | Cursor persistence wrapper (decorator) |
| `async-sqlite-client-store.js` | 978 | Async SQLite with write queue + lifecycle |
| `sqlite-sync-store.js` | 448 | Server-side sync (better-sqlite3) |
| `libsql-sync-store.js` | 384 | Server-side sync (LibSQL) |
| `in-memory-sync-store.js` | 141 | In-memory server-side sync |
| `materialized-view-runtime.js` | 575 | Shared runtime for view projection |

### 1.2 Duplicated Patterns Across Implementations

Every pattern below is copy-pasted with minor syntactic variations (sync vs async, named params vs positional args, `db.prepare` vs `db.execute` vs `requestToPromise`):

| Pattern | Duplicated In # Files | Est. Lines Each | Total Waste |
|---------|----------------------|-----------------|-------------|
| `normalizeCommittedEvent()` | 5 | ~5 | 20 |
| `toComparisonKey()` | 7 | ~7 | 42 |
| `parseDraft()` / `parseCommittedRow()` | 6 | ~15-25 | ~100 |
| `createSchema()` DDL | 5 | ~45 | 180 |
| `validateSchema()` | 5 | ~25 | 100 |
| `initializeSchema()` | 5 | ~20 | 80 |
| `assertCommittedInvariant()` | 5 | ~25 | 100 |
| `saveCursorMonotonic()` | 3 | ~12 | 24 |
| `runPragmas()` | 5 | ~6 | 24 |
| `createMaterializedViewRuntime()` wiring | 5 | ~60-80 | ~300 |
| `loadCursor`/`getCursor` (identical methods) | 5 | ~8 | 32 |
| `loadDraftsOrdered`/`listDraftsOrdered` (identical methods) | 5 | ~8 | 32 |
| `insertDraft` + `insertDrafts` | 5 | ~30 | 120 |
| `applySubmitResult` core logic | 5 | ~35 | 140 |
| `applyCommittedBatch` core logic | 5 | ~30 | 120 |
| Materialized view pass-through methods (6 methods × 5 stores) | 5 | ~35 | 140 |
| `ensureOpen` / lifecycle boilerplate | 5 | ~20 | 80 |
| `parseIntSafe()` | 3 (local redefines) | ~3 | 6 |
| `tableHasColumn()` / `getTableColumnType()` | 5 | ~8 | 32 |

**Estimated duplication: ~1,700 lines** across 5,303 total (~32% pure waste).

### 1.3 Root Cause: No Abstraction Layer

The stores have **no shared base**. Each store independently implements:

1. The **full storage contract** (~20 methods)
2. **SQL DDL** (identical schema across SQLite backends)
3. **Row serialization/deserialization** (snake_case ↔ camelCase)
4. **Lifecycle management** (init/close/ensureOpen)
5. **Materialized view runtime** wiring (6 pass-through methods)
6. **Business logic** (submit result processing, committed batch, cursor monotonicity)

The RouteVN consumer's 500+ line adapter exists because the store abstraction exposes too many implementation details while hiding too few.

### 1.4 The Two Store Families

**Client stores** (`*-client-store.js`) — used by clients:
- Drafts (pending local changes)
- Committed events (server-confirmed)
- Cursor tracking
- Materialized view runtime
- 20+ method interface

**Sync stores** (`*-sync-store.js`) — used by servers:
- `commitOrGetExisting()` (idempotent insert)
- `listCommittedSince()` (paginated scan)
- `getMaxCommittedId()` / `getMaxCommittedIdForProject()`
- Only committed events table
- 5 method interface

These share: schema DDL, row parsing, pragmas, validation, `toComparisonKey`, `canonicalizeSubmitItem`.

---

## 2. Proposed Architecture

### 2.1 Minimal Core Interface vs Current Bloated Contract

**Current contract** (client store — what each of 5 stores implements independently):

```
init, close, loadCursor, getCursor,
insertDraft, insertDrafts, loadDraftsOrdered, listDraftsOrdered,
applySubmitResult, applyCommittedBatch,
loadMaterializedView, subscribeMaterializedView,
evictMaterializedView, invalidateMaterializedView, flushMaterializedViews,
listCommitted, listCommittedAfter
```

Plus `_debug` namespace. That's **17+ methods** per store.

**Proposed minimal adapter interface** (what each backend implements):

```javascript
/**
 * A storage adapter only needs to implement 8 primitive operations.
 * All higher-level logic (draft→committed transitions, cursor monotonicity,
 * materialized views) moves to the core.
 */
const StorageAdapter = {
  // Lifecycle
  init:    () => Promise<void>,
  close:   () => Promise<void>,

  // Drafts
  insertDrafts:   (drafts: DraftInput[]) => Promise<void>,
  deleteDrafts:   (ids: string[]) => Promise<void>,
  loadDraftsOrdered: () => Promise<DraftRow[]>,

  // Committed events
  insertCommittedEvent: (event: CommittedInput) => Promise<{ inserted: boolean }>,
  getCommittedById:     (id: string) => Promise<CommittedRow | null>,
  listCommittedAfter:   (sinceCommittedId: number, limit: number) => Promise<CommittedRow[]>,

  // Cursor (app_state key-value)
  loadCursor:  () => Promise<number>,
  saveCursor:  (cursor: number) => Promise<void>,

  // Materialized view checkpoints (optional — adapters that don't support this
  // return undefined from loadCheckpoint, and the runtime stays in-memory only)
  loadCheckpoint:   (viewName: string, partition: string) => Promise<Checkpoint | undefined>,
  saveCheckpoint:   (checkpoint: Checkpoint) => Promise<void>,
  deleteCheckpoint: (viewName: string, partition: string) => Promise<void>,
};
```

That's **13 methods** at the adapter level, but critically, the adapter is **purely a persistence layer** — it contains ZERO business logic. The business logic (invariant checking, normalization, materialized view orchestration) lives once in the core.

### 2.2 Repository Pattern with Pluggable Adapters

```
┌─────────────────────────────────────────────────┐
│              ClientStore (public API)            │
│  init/close/loadCursor/insertDraft/             │
│  applySubmitResult/applyCommittedBatch/         │
│  loadMaterializedView/subscribeMaterializedView │
│  listCommitted/listCommittedAfter               │
├─────────────────────────────────────────────────┤
│            ClientStoreCore (business logic)      │
│  - normalizeCommittedEvent()    (shared)        │
│  - toComparisonKey()            (shared)        │
│  - assertCommittedInvariant()   (shared)        │
│  - saveCursorMonotonic()        (shared)        │
│  - applySubmitResult logic      (shared)        │
│  - applyCommittedBatch logic    (shared)        │
│  - MaterializedViewRuntime      (shared)        │
├─────────────────────────────────────────────────┤
│           StorageAdapter (pluggable)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │ InMemory │ │ IndexedDB│ │   SQLite     │    │
│  │ Adapter  │ │ Adapter  │ │   Adapter    │    │
│  └──────────┘ └──────────┘ │  ┌────────┐  │    │
│                            │  │Sync    │  │    │
│                            │  │better- │  │    │
│                            │  │sqlite3 │  │    │
│                            │  ├────────┤  │    │
│                            │  │Async   │  │    │
│                            │  │SQLite  │  │    │
│                            │  │(Tauri) │  │    │
│                            │  ├────────┤  │    │
│                            │  │LibSQL  │  │    │
│                            │  │(Turso) │  │    │
│                            │  └────────┘  │    │
│                            └──────────────┘    │
├─────────────────────────────────────────────────┤
│            SchemaManager (shared)                │
│  - createSchema()    (shared DDL)               │
│  - validateSchema()  (shared validation)        │
│  - initializeSchema()(shared migration logic)   │
│  - runPragmas()      (shared config)            │
├─────────────────────────────────────────────────┤
│         RowCodec (shared serialization)          │
│  - parseDraft()          (shared)               │
│  - parseCommittedRow()   (shared)               │
│  - serializeDraftRow()   (shared)               │
│  - serializeCommittedRow() (shared)             │
│  - encodeMaterializedValue() (shared)           │
└─────────────────────────────────────────────────┘
```

### 2.3 Concrete Code: The Unified Core

#### `src/store-core/client-store-core.js` — Business Logic (written once)

```javascript
import { canonicalizeSubmitItem } from "../canonicalize.js";
import {
  buildCommittedEventFromDraft,
  normalizeClientTs,
} from "../event-record.js";
import { normalizeMaterializedViewDefinitions } from "../materialized-view.js";
import { createMaterializedViewRuntime } from "../materialized-view-runtime.js";
import { throwIfClosed } from "../store-errors.js";

// ─── Shared Business Logic (currently duplicated ×5) ───

export const normalizeCommittedEvent = (event) => ({
  ...event,
  payload: structuredClone(event.payload),
  clientTs: normalizeClientTs(event.clientTs, {
    defaultClientTs: event.meta?.clientTs,
  }),
});

export const toComparisonKey = (event) =>
  canonicalizeSubmitItem({
    partition: event.partition,
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    clientTs: normalizeClientTs(event.clientTs),
  });

export const assertCommittedInvariant = async (adapter, event) => {
  const existing = await adapter.getCommittedById(event.id);
  if (existing) {
    if (
      existing.committedId !== event.committedId ||
      toComparisonKey(existing) !== toComparisonKey(event)
    ) {
      throw new Error(
        `committed event invariant violation for id ${event.id}: conflicting duplicate`,
      );
    }
    return false; // already exists, matches
  }
  return true; // safe to insert
};

// ─── Core Store Factory ───

export const createClientStoreCore = ({ adapter, materializedViews }) => {
  let closed = false;
  let materializedViewRuntime;

  const materializedViewDefinitions =
    normalizeMaterializedViewDefinitions(materializedViews);

  const ensureOpen = () => {
    throwIfClosed(closed, "client store", "client_store_closed");
  };

  const initRuntime = () => {
    if (materializedViewRuntime) return;
    materializedViewRuntime = createMaterializedViewRuntime({
      definitions: materializedViewDefinitions,
      getLatestCommittedId: async () => {
        const events = await adapter.listCommittedAfter(
          Number.MAX_SAFE_INTEGER - 1,
          1,
        );
        return events.length > 0 ? events[0].committedId : 0;
      },
      listCommittedAfter: async ({ sinceCommittedId, limit }) => {
        const rows = await adapter.listCommittedAfter(sinceCommittedId, limit);
        return rows; // adapter already returns parsed objects
      },
      loadCheckpoint:
        typeof adapter.loadCheckpoint === "function"
          ? ({ viewName, partition }) => adapter.loadCheckpoint(viewName, partition)
          : undefined,
      saveCheckpoint:
        typeof adapter.saveCheckpoint === "function"
          ? (cp) => adapter.saveCheckpoint(cp)
          : undefined,
      deleteCheckpoint:
        typeof adapter.deleteCheckpoint === "function"
          ? ({ viewName, partition }) => adapter.deleteCheckpoint(viewName, partition)
          : undefined,
    });
  };

  // ─── Public API (the 17-method contract) ───

  return {
    init: async () => {
      ensureOpen();
      await adapter.init();
      initRuntime();
    },

    close: async () => {
      if (closed) return;
      closed = true;
      if (materializedViewRuntime) {
        await materializedViewRuntime.flushMaterializedViews();
        await materializedViewRuntime.close();
      }
      await adapter.close();
    },

    loadCursor: async () => {
      ensureOpen();
      return adapter.loadCursor();
    },

    getCursor: async () => {
      ensureOpen();
      return adapter.loadCursor(); // same as loadCursor — single implementation
    },

    insertDrafts: async (items) => {
      ensureOpen();
      const normalized = items.map((item) => ({
        ...item,
        payload: structuredClone(item.payload),
        clientTs: normalizeClientTs(item.clientTs, {
          defaultClientTs: item.meta?.clientTs,
        }),
      }));
      await adapter.insertDrafts(normalized);
    },

    insertDraft: async (item) => {
      ensureOpen();
      await adapter.insertDrafts([{
        ...item,
        payload: structuredClone(item.payload),
        clientTs: normalizeClientTs(item.clientTs, {
          defaultClientTs: item.meta?.clientTs,
        }),
      }]);
    },

    loadDraftsOrdered: async () => {
      ensureOpen();
      return adapter.loadDraftsOrdered();
    },

    listDraftsOrdered: async () => {
      ensureOpen();
      return adapter.loadDraftsOrdered(); // same as loadDraftsOrdered
    },

    applySubmitResult: async ({ result }) => {
      ensureOpen();
      if (result.status === "committed") {
        const drafts = await adapter.loadDraftsOrdered();
        const draft = drafts.find((d) => d.id === result.id);
        if (draft) {
          const committedEvent = normalizeCommittedEvent(
            buildCommittedEventFromDraft({
              draft,
              committedId: result.committedId,
              serverTs: result.serverTs,
            }),
          );
          const safeToInsert = await assertCommittedInvariant(adapter, committedEvent);
          if (safeToInsert) {
            await adapter.insertCommittedEvent({
              ...committedEvent,
              createdAt: committedEvent.createdAt ?? Date.now(),
            });
            await materializedViewRuntime.onCommittedEvent(committedEvent);
          }
        }
        await adapter.deleteDrafts([result.id]);
        return;
      }
      if (result.status === "rejected") {
        await adapter.deleteDrafts([result.id]);
      }
    },

    applyCommittedBatch: async ({ events, nextCursor }) => {
      ensureOpen();
      const insertedEvents = [];
      for (const event of events) {
        const committedEvent = normalizeCommittedEvent(event);
        const { inserted } = await adapter.insertCommittedEvent({
          ...committedEvent,
          createdAt: committedEvent.createdAt ?? Date.now(),
        });
        if (inserted) {
          insertedEvents.push(committedEvent);
        }
        // Remove matching draft if any
      }
      await adapter.deleteDrafts(events.map((e) => e.id));

      if (nextCursor !== undefined) {
        const current = await adapter.loadCursor();
        if (nextCursor > current) {
          await adapter.saveCursor(nextCursor);
        }
      }

      for (const event of insertedEvents) {
        await materializedViewRuntime.onCommittedEvent(event);
      }
    },

    // ─── Materialized view pass-through (written once, not ×5) ───
    loadMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
      return materializedViewRuntime.loadMaterializedView({ viewName, partition });
    },
    subscribeMaterializedView: async (args) => {
      ensureOpen();
      return materializedViewRuntime.subscribeMaterializedView(args);
    },
    evictMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
      return materializedViewRuntime.evictMaterializedView({ viewName, partition });
    },
    invalidateMaterializedView: async ({ viewName, partition }) => {
      ensureOpen();
      return materializedViewRuntime.invalidateMaterializedView({ viewName, partition });
    },
    flushMaterializedViews: async () => {
      ensureOpen();
      await materializedViewRuntime.flushMaterializedViews();
    },

    // ─── Queries ───
    listCommitted: async () => {
      ensureOpen();
      return adapter.listCommittedAfter(0, Number.MAX_SAFE_INTEGER);
    },
    listCommittedAfter: async ({ sinceCommittedId = 0, limit = Number.MAX_SAFE_INTEGER } = {}) => {
      ensureOpen();
      return adapter.listCommittedAfter(sinceCommittedId, limit);
    },

    _debug: {
      getDrafts: async () => adapter.loadDraftsOrdered(),
      getCommitted: async () => adapter.listCommittedAfter(0, Number.MAX_SAFE_INTEGER),
      getCursor: async () => adapter.loadCursor(),
    },
  };
};
```

#### `src/store-core/row-codec.js` — Shared Serialization (currently duplicated ×6)

```javascript
import { deserializePayload, serializePayload } from "../payload-codec.js";

export const parseIntSafe = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const parseDraftRow = (row) => ({
  draftClock: parseIntSafe(row.draft_clock, 0),
  id: row.id,
  partition: row.partition,
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: typeof row.payload === "string" || row.payload instanceof Uint8Array
    ? deserializePayload(row.payload)
    : structuredClone(row.payload),
  payloadCompression: row.payload_compression || undefined,
  clientTs: parseIntSafe(row.client_ts, 0),
  createdAt: parseIntSafe(row.created_at, 0),
});

export const parseCommittedRow = (row) => ({
  committedId: parseIntSafe(row.committed_id, 0),
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partition: row.partition,
  type: row.type,
  schemaVersion: parseIntSafe(row.schema_version, 0),
  payload: typeof row.payload === "string" || row.payload instanceof Uint8Array
    ? deserializePayload(row.payload)
    : structuredClone(row.payload),
  payloadCompression: row.payload_compression || undefined,
  clientTs: parseIntSafe(row.client_ts, 0),
  serverTs: parseIntSafe(row.server_ts, 0),
  createdAt: parseIntSafe(row.created_at, 0),
});

export const encodeMaterializedValue = (value) =>
  JSON.stringify(value === undefined ? null : value);
```

#### `src/store-core/schema-manager.js` — Shared Schema (currently duplicated ×5)

```javascript
import { parseIntSafe } from "./row-codec.js";

// ─── Client store schema ───
export const CLIENT_SCHEMA_VERSION = 6;

export const CLIENT_SCHEMA_DDL = {
  localDrafts: `
    CREATE TABLE IF NOT EXISTS local_drafts (
      draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      partition TEXT NOT NULL,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload BLOB NOT NULL,
      payload_compression TEXT DEFAULT NULL,
      client_ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  committedEvents: `
    CREATE TABLE IF NOT EXISTS committed_events (
      committed_id INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT,
      user_id TEXT,
      partition TEXT NOT NULL,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload BLOB NOT NULL,
      payload_compression TEXT DEFAULT NULL,
      client_ts INTEGER NOT NULL,
      server_ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  appState: `
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  materializedViewState: `
    CREATE TABLE IF NOT EXISTS materialized_view_state (
      view_name TEXT NOT NULL,
      partition TEXT NOT NULL,
      view_version TEXT NOT NULL,
      last_committed_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(view_name, partition)
    )`,
};

export const CLIENT_SCHEMA_VALIDATION = {
  localDrafts: {
    requiredColumns: ["partition"],
    forbiddenColumns: ["project_id", "user_id", "meta"],
    payloadType: "BLOB",
  },
  committedEvents: {
    requiredColumns: ["partition", "server_ts"],
    payloadType: "BLOB",
  },
};

// ─── Sync store schema ───
export const SYNC_SCHEMA_VERSION = 4;

export const SYNC_SCHEMA_DDL = {
  committedEvents: `
    CREATE TABLE IF NOT EXISTS committed_events (
      committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      user_id TEXT,
      partition TEXT NOT NULL,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload BLOB NOT NULL,
      payload_compression TEXT DEFAULT NULL,
      client_ts INTEGER NOT NULL,
      server_ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  committedEventsIndex: `
    CREATE INDEX IF NOT EXISTS committed_events_project_committed_idx
    ON committed_events(project_id, committed_id)`,
};

export const SYNC_SCHEMA_VALIDATION = {
  committedEvents: {
    requiredColumns: ["partition"],
    payloadType: "BLOB",
  },
};

// ─── Shared validation logic ───
export const tableHasColumn = async (queryFn, tableName, columnName) => {
  const rows = await queryFn(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
};

export const getTableColumnType = async (queryFn, tableName, columnName) => {
  const rows = await queryFn(`PRAGMA table_info(${tableName})`);
  const column = rows.find((row) => row.name === columnName);
  return typeof column?.type === "string" ? column.type.toUpperCase() : null;
};

export const validateClientSchema = async (queryFn) => {
  const v = CLIENT_SCHEMA_VALIDATION;
  for (const col of v.localDrafts.requiredColumns) {
    if (!(await tableHasColumn(queryFn, "local_drafts", col))) return false;
  }
  for (const col of v.localDrafts.forbiddenColumns) {
    if (await tableHasColumn(queryFn, "local_drafts", col)) return false;
  }
  if (await getTableColumnType(queryFn, "local_drafts", "payload") !== v.localDrafts.payloadType) return false;
  for (const col of v.committedEvents.requiredColumns) {
    if (!(await tableHasColumn(queryFn, "committed_events", col))) return false;
  }
  if (await getTableColumnType(queryFn, "committed_events", "payload") !== v.committedEvents.payloadType) return false;
  return true;
};

// ─── Shared initialization pattern ───
export const createSchemaInitializer = ({ schemaVersion, ddl, validateFn }) => {
  return async ({ queryFn, executeFn, getVersionFn, setVersionFn, inTransactionFn }) => {
    const current = await getVersionFn();
    if (current > schemaVersion) {
      throw new Error(`Unsupported schema version ${current}; runtime supports up to ${schemaVersion}`);
    }
    if (current === 0) {
      await inTransactionFn(async () => {
        for (const ddlSql of Object.values(ddl)) {
          await executeFn(ddlSql);
        }
        if (!(await validateFn(queryFn))) {
          throw new Error("Schema is incompatible; reset required");
        }
        await setVersionFn(schemaVersion);
      });
      return;
    }
    if (current !== schemaVersion) {
      throw new Error(`Store requires reset for schema version ${current}; runtime expects ${schemaVersion}`);
    }
    if (!(await validateFn(queryFn))) {
      throw new Error("Schema is incompatible; reset required");
    }
  };
};
```

### 2.4 Concrete Code: Thin Adapters

#### `src/adapters/in-memory-adapter.js` (~60 lines)

```javascript
import { normalizeClientTs } from "../event-record.js";

export const createInMemoryAdapter = () => {
  const drafts = [];
  const committed = [];
  const committedById = new Map();
  let cursor = 0;
  let nextDraftClock = 1;

  return {
    init: async () => {},
    close: async () => {},

    insertDrafts: async (items) => {
      for (const item of items) {
        if (drafts.find((d) => d.id === item.id)) {
          throw new Error(`draft with id ${item.id} already exists`);
        }
        drafts.push({ draftClock: nextDraftClock++, ...item });
      }
    },

    deleteDrafts: async (ids) => {
      for (const id of ids) {
        const idx = drafts.findIndex((d) => d.id === id);
        if (idx >= 0) drafts.splice(idx, 1);
      }
    },

    loadDraftsOrdered: async () => [...drafts].sort((a, b) =>
      a.draftClock !== b.draftClock ? a.draftClock - b.draftClock : a.id.localeCompare(b.id)
    ),

    insertCommittedEvent: async (event) => {
      const existing = committedById.get(event.id);
      if (existing) return { inserted: false };
      committedById.set(event.id, event);
      committed.push(event);
      committed.sort((a, b) => a.committedId - b.committedId);
      return { inserted: true };
    },

    getCommittedById: async (id) => committedById.get(id) ?? null,

    listCommittedAfter: async (sinceCommittedId, limit) =>
      committed
        .filter((e) => e.committedId > sinceCommittedId)
        .slice(0, limit),

    loadCursor: async () => cursor,
    saveCursor: async (next) => { cursor = Math.max(cursor, next); },

    // No checkpoint persistence for in-memory
    loadCheckpoint: async () => undefined,
    saveCheckpoint: async () => {},
    deleteCheckpoint: async () => {},
  };
};
```

#### `src/adapters/sqlite-adapter.js` (~120 lines, replaces 788)

```javascript
import {
  parseDraftRow,
  parseCommittedRow,
  parseIntSafe,
} from "../store-core/row-codec.js";
import {
  CLIENT_SCHEMA_DDL,
  CLIENT_SCHEMA_VERSION,
  validateClientSchema,
  createSchemaInitializer,
} from "../store-core/schema-manager.js";
import { serializePayload } from "../payload-codec.js";

export const createSqliteAdapter = (db, { applyPragmas = true, journalMode = "WAL", synchronous = "FULL", busyTimeoutMs = 5000 } = {}) => {
  let stmts = null;

  const init = () => {
    if (stmts) return;

    // Pragmas
    if (applyPragmas) {
      db.exec(`PRAGMA journal_mode=${journalMode};`);
      db.exec(`PRAGMA synchronous=${synchronous};`);
      if (Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0)
        db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
    }

    // Schema
    const current = db.prepare("PRAGMA user_version").get().user_version;
    if (current === 0) {
      const txn = db.transaction(() => {
        for (const ddl of Object.values(CLIENT_SCHEMA_DDL)) db.exec(ddl);
        db.exec(`PRAGMA user_version=${CLIENT_SCHEMA_VERSION};`);
      });
      txn();
    } else if (current !== CLIENT_SCHEMA_VERSION) {
      throw new Error(`Schema mismatch: ${current} vs ${CLIENT_SCHEMA_VERSION}`);
    }

    // Prepare statements
    stmts = {
      loadCursor: db.prepare(`SELECT value FROM app_state WHERE key = 'cursor_committed_id'`),
      saveCursor: db.prepare(`INSERT INTO app_state(key,value) VALUES('cursor_committed_id',@value) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
      insertDraft: db.prepare(`INSERT INTO local_drafts(id,partition,type,schema_version,payload,payload_compression,client_ts,created_at) VALUES(@id,@partition,@type,@schema_version,@payload,@payload_compression,@client_ts,@created_at)`),
      loadDrafts: db.prepare(`SELECT * FROM local_drafts ORDER BY draft_clock ASC, id ASC`),
      deleteDraft: db.prepare(`DELETE FROM local_drafts WHERE id = @id`),
      insertCommitted: db.prepare(`INSERT OR IGNORE INTO committed_events(committed_id,id,project_id,user_id,partition,type,schema_version,payload,payload_compression,client_ts,server_ts,created_at) VALUES(@committed_id,@id,@project_id,@user_id,@partition,@type,@schema_version,@payload,@payload_compression,@client_ts,@server_ts,@created_at)`),
      getCommittedById: db.prepare(`SELECT * FROM committed_events WHERE id = @id`),
      listCommittedAfter: db.prepare(`SELECT * FROM committed_events WHERE committed_id > @since LIMIT @limit`),
      getLatestCommittedId: db.prepare(`SELECT COALESCE(MAX(committed_id),0) AS max_committed_id FROM committed_events`),
      loadMVCheckpoint: db.prepare(`SELECT * FROM materialized_view_state WHERE view_name=@view_name AND partition=@partition`),
      saveMVCheckpoint: db.prepare(`INSERT INTO materialized_view_state(view_name,partition,view_version,last_committed_id,value,updated_at) VALUES(@view_name,@partition,@view_version,@last_committed_id,@value,@updated_at) ON CONFLICT(view_name,partition) DO UPDATE SET view_version=excluded.view_version,last_committed_id=excluded.last_committed_id,value=excluded.value,updated_at=excluded.updated_at`),
      deleteMVCheckpoint: db.prepare(`DELETE FROM materialized_view_state WHERE view_name=@view_name AND partition=@partition`),
    };
  };

  const close = () => { if (typeof db.close === "function") db.close(); };

  return {
    init: async () => init(),
    close: async () => close(),

    insertDrafts: async (items) => {
      const txn = db.transaction(() => {
        for (const item of items) stmts.insertDraft.run({
          id: item.id, partition: item.partition, type: item.type,
          schema_version: item.schemaVersion, payload: serializePayload(item.payload),
          payload_compression: item.payloadCompression ?? null,
          client_ts: parseIntSafe(item.clientTs),
          created_at: item.createdAt,
        });
      });
      txn();
    },

    deleteDrafts: async (ids) => {
      const txn = db.transaction(() => {
        for (const id of ids) stmts.deleteDraft.run({ id });
      });
      txn();
    },

    loadDraftsOrdered: async () => stmts.loadDrafts.all().map(parseDraftRow),

    insertCommittedEvent: async (event) => {
      const result = stmts.insertCommitted.run({
        committed_id: event.committedId, id: event.id,
        project_id: event.projectId ?? null, user_id: event.userId ?? null,
        partition: event.partition, type: event.type,
        schema_version: event.schemaVersion,
        payload: serializePayload(event.payload),
        payload_compression: event.payloadCompression ?? null,
        client_ts: parseIntSafe(event.clientTs),
        server_ts: event.serverTs, created_at: event.createdAt ?? Date.now(),
      });
      return { inserted: result.changes > 0 };
    },

    getCommittedById: async (id) => {
      const row = stmts.getCommittedById.get({ id });
      return row ? parseCommittedRow(row) : null;
    },

    listCommittedAfter: async (since, limit) =>
      stmts.listCommittedAfter.all({ since, limit }).map(parseCommittedRow),

    loadCursor: async () => {
      const row = stmts.loadCursor.get();
      return row ? parseIntSafe(row.value) : 0;
    },

    saveCursor: async (next) => {
      const current = await module.loadCursor();
      stmts.saveCursor.run({ value: String(Math.max(current, next)) });
    },

    loadCheckpoint: async (viewName, partition) => {
      const row = stmts.loadMVCheckpoint.get({ view_name: viewName, partition });
      if (!row) return undefined;
      return {
        viewVersion: row.view_version,
        lastCommittedId: parseIntSafe(row.last_committed_id),
        value: JSON.parse(row.value),
        updatedAt: parseIntSafe(row.updated_at),
      };
    },

    saveCheckpoint: async (cp) => {
      stmts.saveMVCheckpoint.run({
        view_name: cp.viewName, partition: cp.partition,
        view_version: cp.viewVersion, last_committed_id: cp.lastCommittedId,
        value: JSON.stringify(cp.value === undefined ? null : cp.value),
        updated_at: cp.updatedAt,
      });
    },

    deleteCheckpoint: async (viewName, partition) => {
      stmts.deleteMVCheckpoint.run({ view_name: viewName, partition });
    },
  };
};
```

#### Migration wrappers for backward compatibility

```javascript
// src/in-memory-client-store.js (NEW — 10 lines)
import { createInMemoryAdapter } from "./adapters/in-memory-adapter.js";
import { createClientStoreCore } from "./store-core/client-store-core.js";

export const createInMemoryClientStore = ({ materializedViews } = {}) =>
  createClientStoreCore({
    adapter: createInMemoryAdapter(),
    materializedViews,
  });
```

```javascript
// src/sqlite-client-store.js (NEW — 10 lines)
import { createSqliteAdapter } from "./adapters/sqlite-adapter.js";
import { createClientStoreCore } from "./store-core/client-store-core.js";

export const createSqliteClientStore = (db, opts = {}) =>
  createClientStoreCore({
    adapter: createSqliteAdapter(db, opts),
    materializedViews: opts.materializedViews,
  });
```

### 2.5 Schema Migrations Strategy (Uniform)

Currently: Each store has its own `initializeSchema()` with copy-pasted version checking. The current approach is **version-or-reset** — there are no incremental migrations.

**Proposed: `MigrationRegistry` pattern**

```javascript
// src/store-core/migration-registry.js

export const createMigrationRegistry = (migrations) => {
  // migrations: Map<fromVersion, { toVersion, up: (executeFn) => Promise<void> }>
  const sorted = [...migrations.entries()].sort((a, b) => a[0] - b[0]);
  const latestVersion = sorted[sorted.length - 1]?.[1].toVersion ?? 0;

  return {
    getLatestVersion: () => latestVersion,

    runMigrations: async ({ currentVersion, executeFn, queryFn }) => {
      let version = currentVersion;
      while (version < latestVersion) {
        const migration = migrations.get(version);
        if (!migration) {
          throw new Error(
            `No migration path from schema version ${version}; reset required`
          );
        }
        await migration.up(executeFn, queryFn);
        version = migration.toVersion;
      }
      return version;
    },
  };
};

// Example: adding a future column
// migrations.set(6, {
//   toVersion: 7,
//   up: async (exec) => {
//     await exec(`ALTER TABLE committed_events ADD COLUMN correlation_id TEXT`);
//   },
// });
```

This replaces the current "throw on mismatch" pattern with an actual migration path while keeping the reset-on-incompatible-schema safety valve.

### 2.6 WAL/Checkpoint Strategies Per Backend

```javascript
// src/store-core/pragmas.js

export const PRAGMA_PRESETS = {
  // Better-sqlite3 (desktop, local file): Maximum durability
  sqliteDesktop: {
    journalMode: "WAL",
    synchronous: "FULL",
    busyTimeoutMs: 5000,
  },

  // LibSQL (remote/Turso): Server handles durability
  libsqlRemote: {
    applyPragmas: false, // Turso manages WAL
  },

  // Tauri async-sqlite (mobile/desktop): Balance performance
  tauriAsync: {
    journalMode: "WAL",
    synchronous: "NORMAL", // Faster, WAL provides safety
    busyTimeoutMs: 5000,
  },
};

// ─── WAL Checkpoint Strategy ───
// After heavy writes (applyCommittedBatch with many events),
// optionally run PRAGMA wal_checkpoint(PASSIVE) to keep WAL size bounded.

export const createWalCheckpointStrategy = ({ executeFn, thresholdBytes = 10_000_000, intervalMs = 60_000 }) => {
  let lastCheckpoint = Date.now();
  let bytesWritten = 0;

  return {
    onWrite: (bytes) => { bytesWritten += bytes; },
    maybeCheckpoint: async () => {
      const now = Date.now();
      if (bytesWritten >= thresholdBytes || now - lastCheckpoint >= intervalMs) {
        await executeFn("PRAGMA wal_checkpoint(PASSIVE)");
        bytesWritten = 0;
        lastCheckpoint = now;
      }
    },
  };
};
```

### 2.7 Connection Pooling and Locking (SQLite Specific)

The async-sqlite-client-store has the most sophisticated concurrency management:

```javascript
// Current async-sqlite-client-store.js lines 150-211:
// - activeOperationCount tracking
// - writeTail queue (serializes writes)
// - waitForIdle for graceful shutdown
// - beginOperation/finishOperation reference counting
```

**Proposed: Extract into reusable `ConnectionPool`**

```javascript
// src/store-core/connection-pool.js

export const createConnectionPool = ({ driver }) => {
  let activeOperationCount = 0;
  let idleResolver;
  let writeTail = Promise.resolve();
  let closing = false;
  let closed = false;

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
    await new Promise((resolve) => { idleResolver = resolve; });
  };

  const read = async (run) => {
    if (closed || closing) throw new Error("Connection pool is closed");
    const finish = beginOperation();
    try {
      return await driver.transaction("read", run);
    } finally {
      finish();
    }
  };

  const write = async (run) => {
    if (closed || closing) throw new Error("Connection pool is closed");
    const operation = writeTail
      .catch(() => {})
      .then(() => {
        const finish = beginOperation();
        return driver.transaction("write", run).finally(finish);
      });
    writeTail = operation.catch(() => {});
    return operation;
  };

  const shutdown = async () => {
    closing = true;
    await writeTail.catch(() => {});
    await waitForIdle();
    closed = true;
    if (typeof driver.close === "function") await driver.close();
  };

  return { read, write, shutdown, waitForIdle };
};
```

Usage in async-sqlite adapter:

```javascript
import { createConnectionPool } from "../store-core/connection-pool.js";

export const createAsyncSqliteAdapter = ({ driver, ...pragmaOpts }) => {
  const pool = createConnectionPool({ driver });
  // ... adapter methods use pool.read() / pool.write()
};
```

### 2.8 Materialized View Runtime Duplication

**Current state**: The `createMaterializedViewRuntime()` call is constructed identically in all 5 client stores, with only the backend-specific query functions differing. Each store wires 6 methods:

- `getLatestCommittedId` → adapter-specific query
- `listCommittedAfter` → adapter-specific query
- `loadCheckpoint` → adapter-specific query
- `saveCheckpoint` → adapter-specific query
- `deleteCheckpoint` → adapter-specific query

Then each store exposes 6 pass-through methods:
- `loadMaterializedView`
- `subscribeMaterializedView`
- `evictMaterializedView`
- `invalidateMaterializedView`
- `flushMaterializedViews`

That's **6 wiring functions × 5 stores = 30 adapter-specific callbacks** and **6 methods × 5 stores = 30 pass-through methods**, all of which are identical except for the backend query.

**Proposed**: The core `createClientStoreCore` owns the runtime creation and pass-through methods. Adapters only provide the 3 checkpoint operations. The `getLatestCommittedId` and `listCommittedAfter` are derived from the adapter's `listCommittedAfter` method. This eliminates all 60 duplicated call sites.

---

## 3. Impact Summary

### Lines of Code Reduction

| Component | Current | Proposed | Reduction |
|-----------|---------|----------|-----------|
| in-memory-client-store.js | 336 | ~10 (wrapper) + 60 (adapter) | 266 |
| indexeddb-client-store.js | 742 | ~80 (adapter) | 662 |
| libsql-client-store.js | 821 | ~100 (adapter) | 721 |
| sqlite-client-store.js | 788 | ~120 (adapter) | 668 |
| async-sqlite-client-store.js | 978 | ~150 (adapter + pool) | 828 |
| libsql-sync-store.js | 384 | ~80 (adapter) | 304 |
| sqlite-sync-store.js | 448 | ~90 (adapter) | 358 |
| in-memory-sync-store.js | 141 | ~10 (wrapper) + 40 (adapter) | 91 |
| **Shared core** | 0 | ~400 (core + codec + schema + pool) | +400 |
| **persisted-cursor** | 90 | 90 (unchanged, already a decorator) | 0 |
| **Total** | **4,728** | **~1,130** | **~3,600 lines (76% reduction)** |

### Benefits

1. **Single source of truth** for business logic (`normalizeCommittedEvent`, `toComparisonKey`, `assertCommittedInvariant`, cursor monotonicity)
2. **Schema DDL defined once** — adding a column means changing 1 file, not 5
3. **New backends** = ~80-150 lines (just implement the adapter interface)
4. **RouteVN consumer** can work directly with the adapter interface for custom persistence (eliminates the 500+ line wrapper)
5. **Test coverage** — core logic tested once, adapters only test serialization/queries
6. **Migration path** — existing stores become thin wrappers; no breaking API changes

### Migration Strategy

1. Create `src/store-core/` with `client-store-core.js`, `row-codec.js`, `schema-manager.js`, `connection-pool.js`
2. Create `src/adapters/` with one adapter per current store
3. Replace current store files with backward-compatible wrappers (exporting the same factory functions)
4. All existing tests pass unchanged (same public API)
5. Incremental: can be done one store at a time
