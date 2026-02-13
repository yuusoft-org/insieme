# Split Draft And Committed Storage (Future Draft)

This is a design draft for future consideration. It is not part of the current protocol or implementation.

## Motivation

Current docs use one `events` table and update rows from `draft` to `committed` by `id`.

Long-term preference: keep local draft queue and committed event log in separate tables so:
- draft lifecycle stays local and simple,
- committed log stays append-only,
- read paths are clearer (`committed` vs `draft overlay`).

Baseline target in this draft: 2 tables. Optional 3rd table only for reject/audit history.

## Goals

- Keep protocol semantics unchanged (`submit_events_result`, `event_broadcast`, `sync_response`).
- Remove draft->committed status updates on the main event row.
- Keep idempotency guarantees for retries, duplicates, and out-of-order delivery.
- Preserve local draft ordering via `draft_clock`.
- Keep the baseline model to 2 tables.

## Non-Goals

- No protocol wire change in this draft.
- No change to server authority (`committed_id` remains canonical order).
- No attempt to solve cross-backend allocator details beyond interface requirements.

## Proposed Local Schema

```sql
CREATE TABLE local_drafts (
  draft_clock INTEGER PRIMARY KEY AUTOINCREMENT, -- local monotonic order key
  id TEXT NOT NULL UNIQUE,                       -- event UUID
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  partitions TEXT NOT NULL,                      -- normalized set (JSON array)
  created_at INTEGER NOT NULL
);

CREATE INDEX local_drafts_order
  ON local_drafts(draft_clock, id);

CREATE TABLE committed_events (
  committed_id INTEGER PRIMARY KEY,     -- global server order
  id TEXT NOT NULL UNIQUE,              -- global event UUID
  client_id TEXT NOT NULL,              -- origin client
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  partitions TEXT NOT NULL,             -- normalized set (JSON array)
  status_updated_at INTEGER NOT NULL
);

-- Optional 3rd table only if UI/product needs rejected history:
CREATE TABLE rejected_drafts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  partitions TEXT NOT NULL,
  rejected_at INTEGER NOT NULL,
  reason TEXT
);
```

Notes:
- `draft_clock` exists only in `local_drafts`.
- `committed_events` is append-only from the client point of view.
- `draft_clock` should be allocated atomically by storage on insert (for example auto-increment key).
- Scope local storage per authenticated `client_id` (recommended), so one monotonic draft sequence is sufficient.

## Data Flow

### 1) Create local draft

- Insert into `local_drafts` and let storage assign `draft_clock` atomically.
- Apply optimistic UI from draft overlay.

### 2) Submit queue

- Read pending rows from `local_drafts` ordered by `(draft_clock, id)`.
- Send `submit_events` preserving that order.

### 3) Commit result for local draft

On `submit_events_result` with `status=committed`:
- In one transaction:
  - load draft payload from `local_drafts` by `id`,
  - insert into `committed_events` with returned `committed_id`,
  - delete `local_drafts` row by `id`.

If insert hits existing `committed_id` or `id`, treat as idempotent and still delete the local draft row when safe.

### 4) Rejected local draft

On `submit_events_result` with `status=rejected`:
- delete from `local_drafts`,
- optionally insert into `rejected_drafts` (if enabled).

### 5) Remote commit (broadcast/sync)

On `event_broadcast` or `sync_response.events`:
- insert into `committed_events` (`ON CONFLICT DO NOTHING`),
- delete matching `local_drafts.id` if present (covers reconnect/retry races).

## Read Model

- Committed state per partition:
  - query `committed_events` by partition membership, `ORDER BY committed_id`.
- Draft overlay per partition:
  - query `local_drafts` by partition membership, `ORDER BY draft_clock, id`.
- Effective state:
  - committed state + draft overlay.

## Invariants

- `committed_id` is unique and monotonic (server invariant).
- `id` is unique in `committed_events`.
- `local_drafts` contains only unresolved local drafts.
- A committed event can be received multiple times; inserts must be idempotent.
- A local draft can be resolved via submit result or sync path; either path must converge.

## Failure Handling

- If commit result arrives but local draft row is missing, request sync from durable cursor and rely on committed stream to fill data.
- If crash happens after committed insert but before draft delete, restart cleanup deletes stale local draft when same `id` appears committed.
- If crash happens before committed insert, retry/sync restores committed row idempotently.

## Migration Sketch

1. Add new tables (`local_drafts`, `committed_events`).
2. Dual-write new commits into `committed_events` while old read path stays active.
3. Switch read path:
   - committed reads from `committed_events`,
   - pending draft reads from `local_drafts`.
4. Stop writing draft/committed status transitions in legacy table.
5. Remove legacy status-based paths after parity tests pass.

## Open Questions

- Should rejected drafts be persisted by default or behind a feature flag?
- Should `committed_events` store a payload hash for diagnostics (`same committed_id, different id`)?
- Should retention prune local committed rows after snapshots in this model, or keep full client history?
- For browser multi-tab, should one leader tab own submit queue draining by default?
- For backends without native auto-increment, should we require a lock-based allocator or keep single-writer mode only?
