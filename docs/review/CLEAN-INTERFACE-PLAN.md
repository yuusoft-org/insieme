# Insieme v3 — Clean Interface Plan

**No backward compatibility. Clean break.**

---

## What We Keep

The wire protocol (5 message types, cursor-based sync, idempotent commits) works. The event-sourced model works. The authoritative server model works. We keep all of this and change only the programmatic interfaces.

---

## Part 1: Storage — One Core, Thin Adapters

### Problem
6 store implementations. ~3,600 lines of duplicated business logic. Every store independently implements `normalizeCommittedEvent`, `toComparisonKey`, `assertCommittedInvariant`, `parseDraft`, `parseCommittedRow`, `validateSchema`, `createSchema`, `applySubmitResult`, `applyCommittedBatch`, plus 6 materialized-view pass-through methods.

### Solution: `createClientStore(adapter)` + `createSyncStore(adapter)`

**The adapter interface (what you implement for a new backend):**

```ts
interface StorageAdapter {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Drafts
  insertDrafts(items: DraftInput[]): Promise<void>;
  deleteDrafts(ids: string[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftRow[]>;

  // Committed
  insertCommittedEvent(event: CommittedInput): Promise<{ inserted: boolean }>;
  getCommittedById(id: string): Promise<CommittedRow | null>;
  listCommittedAfter(sinceCommittedId: number, limit: number): Promise<CommittedRow[]>;
  getMaxCommittedId(): Promise<number>;

  // Cursor
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;

  // Checkpoints (optional — return undefined to opt out)
  loadCheckpoint?(viewName: string, partition: string): Promise<CheckpointData | undefined>;
  saveCheckpoint?(checkpoint: CheckpointData): Promise<void>;
  deleteCheckpoint?(viewName: string, partition: string): Promise<void>;
}
```

13 methods. Zero business logic. Pure read/write/delete.

**What you get back (the public store):**

```ts
interface ClientStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // Drafts
  insertDraft(item: DraftItem): Promise<void>;
  insertDrafts(items: DraftItem[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftItem[]>;

  // Committed
  applySubmitResult(result: SubmitResult): Promise<void>;
  applyCommittedBatch(batch: { events: CommittedEvent[], nextCursor?: number }): Promise<void>;
  listCommitted(): Promise<CommittedEvent[]>;
  listCommittedAfter(sinceCommittedId: number, limit?: number): Promise<CommittedEvent[]>;

  // Cursor
  loadCursor(): Promise<number>;

  // Materialized views
  loadMaterializedView(query: { viewName: string, partition: string }): Promise<MaterializedViewValue>;
  subscribeMaterializedView(query: { viewName: string, partition: string, onChange: (value: ViewUpdate) => void }): Promise<Unsubscribe>;
  flushMaterializedViews(): Promise<void>;

  // Stats (was: consumer had to build this from scratch)
  getStats(): Promise<StoreStats>;
}

interface StoreStats {
  draftCount: number;
  committedCount: number;
  latestCommittedId: number;
  latestDraftClock: number;
}

interface CheckpointData {
  viewName: string;
  partition: string;
  viewVersion: string;
  lastCommittedId: number;
  value: unknown;
  meta?: Record<string, unknown>;  // ← consumer can store arbitrary metadata
  updatedAt: number;
}
```

All business logic (dedup, invariant checking, cursor monotonicity, materialized view wiring) lives in the core — written once.

**Built-in adapters we ship:**

```js
import { createClientStore, adapters } from "insieme/client";

// In-memory (testing)
const store = createClientStore(adapters.inMemory());

// IndexedDB (browser)
const store = createClientStore(adapters.indexedDb({ dbName: "my-db" }));

// better-sqlite3 (Node)
const store = createClientStore(adapters.sqlite({ db: betterSqlite3Db }));

// LibSQL (cross-platform)
const store = createClientStore(adapters.libsql({ client: libsqlClient }));

// Async SQLite (Tauri)
const store = createClientStore(adapters.asyncSqlite({
  driver: tauriSqlDriver,
  busyTimeout: 15000,  // ← built-in SQLITE_BUSY handling
  walCheckpoint: { mode: "passive", intervalMs: 10000 },  // ← built-in WAL management
}));
```

The `asyncSqlite` adapter natively handles:
- SQLITE_BUSY retry with exponential backoff
- Operation serialization (no consumer queue needed)
- WAL checkpoint management (configurable policy)
- Connection pinning workarounds for Tauri

**Estimated reduction:** 4,728 lines → ~1,300 lines (core + 5 adapters)

### Sync store (server side) — same pattern:

```ts
interface SyncStoreAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  commitEvent(event: CommitInput): Promise<{ deduped: boolean, committedEvent: CommittedEvent }>;
  getCommittedById(id: string): Promise<CommittedEvent | null>;
  listCommittedSince(query: { projectId: string, sinceCommittedId: number, limit: number, syncToCommittedId?: number }): Promise<{ events: CommittedEvent[], hasMore: boolean, nextSinceCommittedId: number }>;
  getMaxCommittedIdForProject(projectId: string): Promise<number>;
  getMaxCommittedId(): Promise<number>;
}

function createSyncStore(adapter: SyncStoreAdapter): SyncStore;
```

---

## Part 2: Client — Formal State Machine

### Problem
7 boolean flags. 128 combinations. 116 invalid. Compound guards scattered everywhere.

### Solution: 8-state FSM

```
IDLE → HANDSHAKE → SYNCING → READY ⇄ SUBMITTING
                                    ↓ disconnect
                               RECONNECTING → DISCONNECTED
any → CLOSED
any → IDLE (via stop)
```

```ts
// The new createSyncClient
interface SyncClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;

  submitEvent(input: EventInput): Promise<SubmitResult>;
  submitEvents(inputs: EventInput[]): Promise<SubmitResult[]>;
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;

  // Status — domain type, not raw internals
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;

  // Draft queue visibility (was: consumer had to access store directly)
  getPendingDraftCount(): number;
  getPendingDrafts(): Promise<DraftItem[]>;
}

type ClientStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "syncing" }
  | { state: "ready" }
  | { state: "submitting" }
  | { state: "reconnecting"; attempt: number; nextRetryInMs: number }
  | { state: "disconnected" }
  | { state: "closed" };

type SubmitResult =
  | { id: string; status: "committed"; committedId: number; serverTs: number }
  | { id: string; status: "queued" }   // ← NEW: clear "queued offline" signal
  | { id: string; status: "rejected"; reason: string; message: string };
```

Key changes:
- **`onStatusChange`** — no more polling `getStatus().connected`
- **`SubmitResult.status: "queued"`** — consumer can now distinguish offline-queued from committed
- **`getPendingDraftCount` / `getPendingDrafts`** — queue visibility for UI
- No reconnect config boilerplate — `reconnect: true` uses sensible defaults

```js
const client = createSyncClient({
  transport,
  store,
  token: "jwt",
  clientId: "C1",
  projectId: "workspace-1",
  reconnect: true,  // ← just true. sensible defaults.
});
```

---

## Part 3: Command Session — First-Class Projections

### Problem
RouteVN built 2,492 lines of projection replay, 350 lines of SQLite workarounds, and 370 lines of boilerplate. The `command-sync-session` is insufficient — no view management, no lifecycle events, no checkpoint integration.

### Solution: Views are first-class on the session

```ts
interface CommandSyncSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;

  submitCommand(command: Command): Promise<CommandResult>;
  submitCommands(commands: Command[]): Promise<CommandResult[]>;

  // Status (same as SyncClient, proxied)
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;

  // Draft queue
  getPendingDraftCount(): number;

  // NEW: built-in projection management
  getView(name: string, partition: string): Promise<ProjectionValue | undefined>;
  subscribeView(name: string, partition: string, onChange: (value: ViewUpdate) => void): Unsubscribe;

  // NEW: validation hook
  validateCommand?: (command: Command) => void;

  // Error state (unified — consumer doesn't need dual tracking)
  getLastError(): SessionError | null;
  clearLastError(): void;
}

type CommandResult =
  | { id: string; status: "committed"; committedId: number }
  | { id: string; status: "queued" }
  | { id: string; status: "rejected"; reason: string; message: string };
```

**The key addition — views are declared at session creation:**

```ts
function createCommandSyncSession({
  // Connection
  token: string;
  actor: { clientId: string };
  projectId: string;
  transport?: Transport;
  store?: ClientStore;

  // Command mapping
  mapCommandToSyncEvent: (command: Command) => SyncEvent;
  mapCommittedToCommand: (event: CommittedEvent) => Command | null;

  // NEW: projection definitions
  views?: ViewDefinition[];

  // NEW: callbacks
  onCommandCommitted?: (info: { command: Command; event: CommittedEvent; isLocal: boolean }) => void;
  onStatusChange?: (status: ClientStatus) => void;
  onViewUpdate?: (update: { viewName: string; partition: string; value: unknown }) => void;
  onError?: (error: SessionError) => void;

  // Lifecycle
  reconnect?: boolean | ReconnectPolicy;
  logger?: Logger;
}): CommandSyncSession;

interface ViewDefinition {
  name: string;
  version: string;
  // Single partition
  partition?: string;
  // OR: multiple partitions with pattern
  partitionPattern?: string;  // e.g. "scene-{sceneId}"
  // Reduce function
  reduce: (state: unknown, event: CommittedEvent) => unknown;
  initialState?: () => unknown;
  // Checkpoint policy
  checkpoint?: {
    mode: "off" | "every" | "threshold";
    every?: number;           // checkpoint every N events
    debounceMs?: number;      // debounce checkpoint writes
    meta?: () => Record<string, unknown>;  // attach arbitrary metadata
  };
}
```

**What this eliminates for RouteVN:**

| RouteVN code (lines) | What it does | Eliminated by |
|---|---|---|
| ~2,492 (`projection.js`) | Full projection replay engine | View definitions with `reduce` + automatic replay |
| ~250 (replay error recovery) | Idempotent replay, skip-duplicate, sequential fallback | Built-in idempotent replay mode |
| ~300 (multi-partition management) | Scene partition tracking, auto-adopt, prune | `partitionPattern` + automatic lifecycle |
| ~170 (checkpoint envelope) | Custom metadata on checkpoints | `checkpoint.meta` |
| ~370 (boilerplate wrappers) | Transport adapter, collab service, store wrapper | Session provides everything |
| ~350 (SQLite workarounds) | Lock retry, op queue, WAL, connection pinning | Adapter handles it |
| **~3,932 lines** | | **→ ~50 lines of config** |

---

## Part 4: Error Hierarchy

### Problem
Plain `Error` objects with `.code`. No structured error types. Consumer invented `ProjectRepositoryReplayError`, `ProjectStoreFormatUnsupportedError`, error normalization, dual error state.

### Solution

```ts
class InsiemeError extends Error {
  code: string;
  details: Record<string, unknown>;
}

class TransportError extends InsiemeError { code: "transport_disconnected" | "transport_connect_failed" | "transport_send_failed" }
class AuthError extends InsiemeError { code: "auth_failed" | "forbidden" }
class ValidationError extends InsiemeError { code: "validation_failed" | "bad_request" }
class SyncError extends InsiemeError { code: "sync_failed" | "protocol_error" }
class StoreError extends InsiemeError {
  code: "store_closed" | "store_init_failed" | "schema_version_mismatch" | "busy_timeout" | "corrupt_history";
}
class ReplayError extends InsiemeError {
  code: "replay_failed";
  details: { failedEventIndex: number; failedEventId: string; nearbyEvents: CommittedEvent[] };
}
```

---

## Part 5: Transport Interface (Minor Cleanup)

The transport interface is clean. One small addition:

```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  // NEW: optional logger passthrough
  setLogger?(logger: Logger): void;
}
```

No consumer-written logging adapter needed.

---

## Part 6: Server Interface (Minimal Changes)

The server interface is already decent. Changes:

```ts
interface SyncServer {
  attachConnection(transport: ServerTransport): Connection;
  shutdown(): Promise<void>;

  // NEW: health check
  getStats(): ServerStats;
}

interface ServerStats {
  activeConnections: number;
  activeProjects: number;
  totalCommittedEvents: number;
}
```

---

## Summary of New Public API Surface

### Entry points (unchanged)
- `insieme/client` — browser + generic client
- `insieme/node` — adds server + Node adapters
- `insieme/browser` — explicit browser
- `insieme/server` — backward compat alias

### What changed vs v2

| v2 | v3 | Why |
|---|---|---|
| `createInMemoryClientStore()` | `createClientStore(adapters.inMemory())` | Unified interface |
| `createIndexedDbClientStore(opts)` | `createClientStore(adapters.indexedDb(opts))` | Unified interface |
| `createSqliteClientStore(db)` | `createClientStore(adapters.sqlite({ db }))` | Unified interface |
| `createLibsqlClientStore(client)` | `createClientStore(adapters.libsql({ client }))` | Unified interface |
| `createAsyncSqliteClientStore({ driver })` | `createClientStore(adapters.asyncSqlite({ driver, busyTimeout, walCheckpoint }))` | Unified + built-in locking |
| `createCommandSyncSession(opts)` | Same signature + `views[]` + `onStatusChange` + `onViewUpdate` | Projections are first-class |
| `createSyncClient(opts)` | Same signature + `onStatusChange` + `getPendingDraftCount` | Status + queue visibility |
| `createSyncServer(opts)` | Same signature + `getStats()` | Observability |
| Consumer writes 3,000+ lines | Consumer writes ~50 lines | That's the point |

### Files we delete
- `in-memory-client-store.js` → replaced by `adapters/in-memory.js` (60 lines)
- `indexeddb-client-store.js` → replaced by `adapters/indexed-db.js` (~100 lines)
- `sqlite-client-store.js` → replaced by `adapters/sqlite.js` (~120 lines)
- `libsql-client-store.js` → replaced by `adapters/libsql.js` (~100 lines)
- `async-sqlite-client-store.js` → replaced by `adapters/async-sqlite.js` (~150 lines)
- `persisted-cursor-client-store.js` → absorbed into core

### Files we add
- `src/store-core/client-store-core.js` — unified business logic (~600 lines)
- `src/store-core/sync-store-core.js` — unified server logic (~200 lines)
- `src/store-core/row-codec.js` — shared serialization (~100 lines)
- `src/store-core/schema-manager.js` — shared DDL + validation (~150 lines)
- `src/client-state-machine.js` — FSM (~100 lines)
- `src/errors.js` — error hierarchy (~80 lines)
- `src/adapters/in-memory.js` — ~60 lines
- `src/adapters/indexed-db.js` — ~100 lines
- `src/adapters/sqlite.js` — ~120 lines
- `src/adapters/libsql.js` — ~100 lines
- `src/adapters/async-sqlite.js` — ~150 lines (includes SQLITE_BUSY retry, WAL management, op serialization)

### Net line count change
- Delete: ~4,700 lines (old stores + boilerplate)
- Add: ~1,760 lines (core + adapters + FSM + errors)
- **Net reduction: ~2,940 lines** while adding more features

---

## Implementation Order

### Phase 1: Storage unification (biggest bang, no protocol change)
1. Create `store-core/` with `client-store-core.js`, `row-codec.js`, `schema-manager.js`
2. Create `adapters/in-memory.js` — port in-memory store, verify all tests pass
3. Create remaining adapters one at a time, each verified against existing tests
4. Delete old store files

### Phase 2: State machine + error hierarchy
1. Create `client-state-machine.js`
2. Refactor `sync-client.js` to use FSM instead of boolean flags
3. Create `errors.js` error hierarchy
4. Update all throw/catch to use structured errors
5. Add `onStatusChange`, `getPendingDraftCount`, `SubmitResult.status: "queued"`

### Phase 3: Projection engine on session
1. Extend `command-sync-session.js` with `views[]` support
2. Add `partitionPattern` handling, auto-adopt, auto-prune
3. Add `checkpoint.meta`, idempotent replay, sequential fallback
4. Add `getView()`, `subscribeView()`

### Phase 4: Server observability
1. Add `getStats()` to sync server
2. Add `activeConnections`, `activeProjects` tracking
3. (Future: Redis Pub/Sub for horizontal scaling)

### Phase 5: TypeScript
1. Rename `.js` → `.ts` (all at once, now that interfaces are clean)
2. Delete `.d.ts` files — types come from source
3. Strict mode enabled
