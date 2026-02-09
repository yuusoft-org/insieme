# Client Storage

This document defines the client-side storage model: the events table, snapshots table, indexes, cursor mapping, query patterns, and retention.

## Core Decisions

- **Single local table** for both drafts and committed events.
- **Drafts are saved locally first** (offline-first), then sent asynchronously.
- A draft can be **committed** or **rejected**.
- The client can receive **committed events from other clients**.
- Transport can be **WebSocket** or **polling** with the same semantics.

## Events Table

Recommended columns:

- `id` (UUID, globally unique) — set for local drafts
- `committed_id` (integer, server-assigned incremental id) — set only when committed
- `status` (`draft` | `committed` | `rejected`)
- `partitions` (string[]) — event can belong to multiple partitions
- `type`, `payload` (event data)
- `client_id`, `created_at`, `status_updated_at` (metadata)
- `draft_clock` (integer, local Lamport-style counter for draft ordering)

Notes:
- `id` is globally unique and always present (also used for remote events).
- `client_id` refers to the **origin device** for the event (local or remote).
- `draft_clock` is a **global** Lamport-style counter on the local client.
- `draft_clock` is typically NULL for remote events.
- `created_at` is generated locally when the row is inserted.
- `status_updated_at` is server time supplied on commit/reject.
- `partitions` should be normalized as a **set** (dedupe + stable order).

### SQL Schema

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,                 -- UUID (globally unique)
  committed_id INTEGER,                -- server incremental id (NULL until committed)
  type TEXT NOT NULL,
  payload TEXT NOT NULL,               -- JSON
  partitions TEXT NOT NULL,            -- JSON array of strings
  client_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','committed','rejected')),
  draft_clock INTEGER,                 -- local Lamport-style counter (drafts only)
  created_at INTEGER NOT NULL,         -- local DB insert time
  status_updated_at INTEGER,           -- server time when committed/rejected
  reject_reason TEXT                   -- optional
);

CREATE UNIQUE INDEX events_committed_unique
  ON events(committed_id)
  WHERE committed_id IS NOT NULL;

CREATE INDEX events_committed_order
  ON events(committed_id)
  WHERE status='committed';

CREATE INDEX events_draft_order
  ON events(draft_clock, id)
  WHERE status='draft';
```

## Snapshots Table

Snapshots store **committed-only** state per partition. Drafts are always re-applied on top of snapshots.

Invalidation:
- If `model_version` changes (model mode), discard the snapshot and rebuild from committed events to avoid applying drafts on stale state.
- For tree mode, if your app's initial schema/state changes in a breaking way, clear snapshots or bump an app-level version and invalidate similarly.

```sql
CREATE TABLE snapshots (
  partition TEXT PRIMARY KEY,
  state TEXT NOT NULL,                 -- JSON
  committed_id INTEGER NOT NULL,       -- last committed_id included
  created_at INTEGER NOT NULL,
  model_version INTEGER                -- optional (model mode only)
);

CREATE INDEX snapshots_committed_id
  ON snapshots(partition, committed_id);
```

## Cursor Mapping (Spec vs Runtime)

`committed_id` is the **canonical sync cursor** in the protocol and storage docs.

The JS repository runtime (`src/repository.js`) uses `eventIndex` in snapshots as an internal replay cursor. These are related but not equivalent:

- `committed_id`: global server ordering cursor (wire/storage contract).
- `eventIndex`: local repository replay index (runtime/cache contract).

Adapters that bridge the sync layer and the repository must persist both values. Do not treat `eventIndex` as a protocol cursor unless the local event log is a complete, gap-free prefix of the global committed stream.

## Key Query Patterns

- **Committed state (per partition):**
  - `WHERE status='committed' AND partitions CONTAINS ? ORDER BY committed_id`
- **Draft overlay (per partition):**
  - `WHERE status='draft' AND partitions CONTAINS ? ORDER BY draft_clock, id`

Notes:
- `partitions CONTAINS ?` is a logical operator. Backend-specific implementations:
  - **SQLite**: `EXISTS (SELECT 1 FROM json_each(events.partitions) WHERE value = ?)`
  - **PostgreSQL**: `events.partitions @> to_jsonb(ARRAY[?]::text[])`
  - **IndexedDB**: maintain an auxiliary index store keyed by `(partition, committed_id)`
  - **In-memory**: `event.partitions.includes(partition)`
- For high-volume workloads, consider a normalized `event_partitions(event_id, partition)` join table.

## Retention / Compaction

- After a snapshot is created for a partition, committed events with `committed_id <= snapshot.committed_id` can be archived or pruned.
- Keep **all drafts** (and rejected drafts if you need audit/UI history) until they are resolved and no longer needed by the app.
- For multi-partition events, only prune when **all** referenced partitions have advanced past that `committed_id`. Track this using per-partition watermarks (the highest `committed_id` included in each partition's snapshot).
