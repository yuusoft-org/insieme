# Injected Async SQLite Client Store

Decision status: proposed

## Why This Exists

`createSqliteClientStore(...)` currently targets synchronous SQLite APIs such as
`better-sqlite3`.

That works well in Node, but it does not fit runtimes where SQLite is only
available through an async bridge, especially:

- Tauri desktop apps calling Rust through `invoke(...)`
- JS runtimes with async SQLite bindings
- products that want first-party SQLite support without forcing `insieme` to
  import platform SDKs directly

Today those products have to build large wrapper layers around `insieme`, and
they end up re-owning:

- transaction pinning
- schema bootstrap
- write serialization
- checkpoint persistence
- adapter-specific recovery behavior

That is exactly the kind of repeated boilerplate `insieme` should remove.

## Core Decision

Add first-party support for an injected async SQLite driver.

`insieme` should own:

- client-store schema
- query logic
- draft/commit/cursor semantics
- materialized-view checkpoint behavior

The application should own:

- how SQL reaches SQLite
- platform/runtime packaging
- any Tauri-specific transport into Rust

This means:

- `insieme` must not import `@tauri-apps/*`
- Tauri support is achieved by injection, not by coupling

## Goals

- Provide first-party client-store support for async SQLite runtimes.
- Keep the public `createSyncClient(...)` store contract unchanged.
- Preserve the same logical storage model as other built-in client stores.
- Make Tauri a clean supported integration target without making it a package
  dependency.
- Reuse as much existing SQLite store logic as possible.
- Make normal store usage structurally resistant to common SQLite operational
  failures such as `database is locked`, `database is closed`, and broken
  connection-pool transaction boundaries.

## Non-Goals

- Do not add Tauri-specific imports or package entry points.
- Do not add app/product migration logic into `insieme`.
- Do not change protocol semantics.
- Do not redesign server-side sync stores in this first cut.

## Proposed Public API

Add a new client-store factory:

```js
import { createAsyncSqliteClientStore } from "insieme/client";

const store = createAsyncSqliteClientStore({
  driver,
  materializedViews,
  materializedBackfillChunkSize,
  applyPragmas,
  journalMode,
  synchronous,
  busyTimeoutMs,
});
```

The returned store should implement the same client-store contract used by
`createSyncClient(...)`:

- `init()`
- `loadCursor()`
- `insertDraft()`
- `insertDrafts?()`
- `loadDraftsOrdered()`
- `applySubmitResult()`
- `applyCommittedBatch()`
- materialized-view helpers

The new factory should also be re-exported from `insieme/node`.

## Why Export From `insieme/client`

The new store is runtime-agnostic if it only depends on an injected driver.

That means it is safe to export from:

- `insieme`
- `insieme/client`
- `insieme/browser`
- `insieme/node`

It should not be treated as Node-only just because the backing database is
SQLite.

The existing synchronous `createSqliteClientStore(...)` should remain in
`insieme/node` because it still depends on a Node-style synchronous DB object.

## Driver Contract

The driver contract must guarantee pinned transaction execution.

The store should not issue raw `BEGIN` / `COMMIT` statements across unrelated
async calls, because that is exactly where many JS-side SQLite bridges become
fragile.

The design goal is stronger than "support async SQLite". It should also remove
the main classes of operational bugs teams hit when SQLite is routed through a
JS bridge:

- transaction work escaping the real connection/transaction boundary
- writes racing each other through pool-like abstractions
- long-lived or orphaned handles causing `database is closed`
- app code having to guess when to retry `database is locked`

### Proposed driver shape

```ts
type SqliteValue =
  | null
  | string
  | number
  | Uint8Array
  | ArrayBuffer;

type AsyncSqliteQueryResultRow = Record<string, SqliteValue>;

type AsyncSqliteTx = {
  query(sql: string, args?: SqliteValue[]): Promise<AsyncSqliteQueryResultRow[]>;
  execute(
    sql: string,
    args?: SqliteValue[],
  ): Promise<{ rowsAffected: number; lastInsertRowId?: number | string }>;
};

type AsyncSqliteDriver = {
  init?: () => Promise<void>;
  transaction<T>(
    mode: "read" | "write",
    run: (tx: AsyncSqliteTx) => Promise<T>,
  ): Promise<T>;
  close?: () => Promise<void>;
};
```

### Important rules

- `transaction(...)` must pin all operations in `run(...)` to one real SQLite
  transaction/connection context.
- `mode: "read"` may map to a read-only or deferred transaction.
- `mode: "write"` must provide atomic commit/rollback semantics.
- `insieme` owns SQL strings and statement ordering.
- The driver owns platform-specific execution details.

## Reliability Requirements

The async SQLite design should treat lock/close/pool failures as first-class
design inputs, not adapter-specific cleanup work.

### Invariants

- `insieme` store operations must never depend on caller-managed `BEGIN`,
  `COMMIT`, or shared mutable connection state.
- A write operation must execute inside exactly one real write transaction.
- Driver implementations must provide deterministic write serialization for one
  database handle if the underlying runtime does not already guarantee it.
- `insieme` must not assume a connection pool can preserve transaction
  boundaries across multiple async calls.
- No background store work may continue after `driver.close()` resolves.
- Store shutdown must be explicit: once closed, later operations should fail
  deterministically with a store/driver closed error, not with dangling
  half-executed SQL.

### Tauri-specific implication

For Tauri, the recommended design is one Rust-owned transaction per
`transaction(...)` callback, with Rust also owning:

- the SQLite connection lifecycle
- any single-writer mutex or queue
- busy timeout / retry behavior
- WAL and pragma setup

That keeps these concerns out of JS and makes them enforceable in one place.

The shipped async SQLite adapter should therefore keep `applyPragmas` disabled
by default. Driver-owned pragmas are the safer default for injected runtimes.

## Why This Contract Matters

For Tauri, the recommended implementation is:

- JS injects a driver object
- each `transaction(...)` call maps to one Rust command
- Rust executes the full transaction against SQLite
- Rust returns the collected query/execute results

This keeps transaction correctness in one place and avoids leaking
platform-specific retry/pool logic into app code.

## Schema Strategy

The new async SQLite client store should use the same logical schema as the
existing SQLite client store where possible:

- `local_drafts`
- `committed_events`
- `app_state`
- `materialized_view_state`

The goal is one logical client-store model across:

- IndexedDB
- LibSQL
- synchronous SQLite
- injected async SQLite

The new store should not invent a second schema family unless a real technical
constraint forces it.

## Internal Refactor Plan

The current synchronous SQLite store mixes three concerns in one file:

- schema/bootstrap
- SQL read/write logic
- sync-vs-async execution model

That should be split into shared internal modules.

### Shared internal pieces

- schema creation and validation
- row encode/decode helpers
- payload serialization helpers
- committed/draft invariants
- materialized-view checkpoint helpers

### Adapter-specific pieces

- sync SQLite transaction execution
- async SQLite transaction execution

This should leave:

- `createSqliteClientStore(...)` as the synchronous adapter
- `createAsyncSqliteClientStore(...)` as the injected async adapter

backed by the same storage semantics.

## Materialized Views

The async SQLite store must support the same materialized-view behavior as the
other built-in client stores:

- exact local reads from committed state
- hot in-memory updates on newly inserted committed events
- persisted checkpoints in `materialized_view_state`
- `loadMaterializedView(...)`
- `evictMaterializedView(...)`
- `invalidateMaterializedView(...)`
- `flushMaterializedViews()`

No Tauri-specific special case should exist here.

## Debug And Inspection Surface

The initial implementation may keep `_debug` parity with the existing built-in
stores so the adapter is testable and diagnosable in the same way.

Required parity:

- `_debug.getDrafts()`
- `_debug.getCommitted()`
- `_debug.getCursor()`

Longer term, `insieme` should consider promoting these into stable public
inspection APIs, but that is not required for the first async SQLite cut.

## Error Model

The async SQLite store should not guess platform recovery policy.

Rules:

- SQLite execution errors propagate as adapter errors.
- Transaction rollback is handled by the driver.
- Schema mismatch errors remain explicit and deterministic.
- Busy/retry policy stays at the driver boundary unless `insieme` later adopts
  a generic cross-adapter retry option.

This keeps `insieme` correct without hard-coding Tauri-specific lock handling.

The design should also make certain failures meaningfully rarer:

- `database is locked` should primarily indicate real external contention, not
  accidental JS-side transaction splitting.
- `database is closed` should primarily indicate an explicit lifecycle mistake,
  not hidden background work running after teardown.
- connection-pool bugs should be blocked by the driver contract rather than
  left to app-level discipline.

## Reference Tauri Integration

This plan is motivated by Tauri, so the repo should include a documented
reference pattern, but not a Tauri dependency.

Recommended example shape:

```js
import { createAsyncSqliteClientStore } from "insieme/client";

const store = createAsyncSqliteClientStore({
  driver: createTauriSqliteDriver({
    invoke,
    databaseId: "project.db",
  }),
});
```

Where `createTauriSqliteDriver(...)` lives in app code or an example project,
not in `insieme` core.

## Implementation Phases

### Phase 1: Freeze API and driver contract

- Add a draft/reference doc for the new factory and driver contract.
- Decide final export path.
- Decide whether `close()` is part of the public contract.

### Phase 2: Extract shared SQLite client-store internals

- Move schema/bootstrap helpers into shared internal modules.
- Move row codec / payload codec / checkpoint helpers into shared modules.
- Keep behavior unchanged for `createSqliteClientStore(...)`.

### Phase 3: Implement `createAsyncSqliteClientStore(...)`

- Add async transaction runner over the injected driver.
- Port all required client-store mutations to the async path.
- Preserve materialized-view support and `_debug` parity.

### Phase 4: Add reference docs and examples

- Update package entry point docs.
- Update JS interface docs.
- Add a reference example for injected async SQLite.
- Mention Tauri as a target integration, not as a dependency.

### Phase 5: Verify with shared adapter contract tests

- Run the same client-store behavior suite against:
  - IndexedDB store
  - LibSQL store
  - synchronous SQLite store
  - async SQLite store

## Required Test Coverage

- schema bootstrap and version mismatch behavior
- `insertDraft` and `insertDrafts` ordering
- `applySubmitResult` committed promotion
- `applySubmitResult` rejection cleanup
- `applyCommittedBatch` idempotency
- draft cleanup on matching committed `id`
- cursor monotonic persistence
- materialized-view replay and checkpoint persistence
- restart/reopen with persisted drafts and committed events
- transaction rollback on mid-operation failure

For the new adapter specifically:

- one transaction callback must observe its own writes
- failed write transaction must not partially persist rows
- read transactions must not require caller-managed `BEGIN` / `COMMIT`
- repeated open/close must not leave background queries running against a
  closed database
- concurrent write requests must serialize or fail deterministically without
  partial persistence
- lock handling must be owned by the driver boundary, not by app-level retry
  loops around store calls

## Documentation Changes Required

If this plan is accepted, update:

- `README.md`
- `docs/README.md`
- `docs/client/storage.md`
- `docs/client/materialized-views.md`
- `docs/reference/javascript-interface.md`
- `docs/reference/package-entrypoints.md`

## Open Questions

- Should the factory name be `createAsyncSqliteClientStore(...)` or
  `createInjectedSqliteClientStore(...)`?
- Should the async SQLite store support configurable busy/retry hooks, or should
  that remain entirely inside the injected driver?
- Should `insieme` define a standard closed-store error shape so apps can
  distinguish lifecycle misuse from SQLite execution failures?
- Do we want a matching async SQLite sync-store adapter later, or should this
  remain client-only for now?

## Recommended First Cut

Keep the first cut narrow:

- ship only the client-side async SQLite adapter
- keep the `createSyncClient(...)` contract unchanged
- keep Tauri integration via injected driver only
- do not bundle any platform SDKs

That gets `insieme` first-party Tauri compatibility where it matters, while
keeping the library centralized, generic, and easier to adopt.
