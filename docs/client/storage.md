# Client Storage

This document defines the minimal client-side storage model.

## Core Decisions

- Two primary tables:
  - `local_drafts` (pending local work)
  - `committed_events` (durable committed stream)
- Drafts are local-first and optimistic.
- Committed stream is append-only from the client perspective.

## Recommended Schema

```sql
CREATE TABLE local_drafts (
  draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- JSON: { type, payload }
  partitions TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE committed_events (
  committed_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- JSON: { type, payload }
  partitions TEXT NOT NULL,
  status_updated_at INTEGER NOT NULL
);
```

Notes:

- `id` is global event UUID and dedupe key.
- `draft_clock` is local ordering only.
- `draft_clock` and `committed_id` primary keys already provide ordered access paths in SQLite.
- `partitions` should be stored as a normalized set representation.
- Reference adapter: `src/sqlite-client-store.js` (`createSqliteClientStore`).

## Optional Tables

Optional only when product requirements need them:

- `snapshots` for faster local startup,
- `rejected_drafts` for UI/audit history.
- `materialized_view_state` + `materialized_view_offsets` for partitioned derived state caching.

## Query Patterns

- Committed state per partition:
  - `status source = committed_events`
  - `ORDER BY committed_id`
- Draft overlay per partition:
  - `status source = local_drafts`
  - `ORDER BY draft_clock, id`

## Apply Rules

When committed event arrives from any path:

1. Insert into `committed_events` with idempotent conflict handling.
2. Delete matching `local_drafts.id` if present.

This converges submit-result and sync/broadcast paths.

## Cursor

- Persist one durable sync cursor: last applied `committed_id`.
- Use it as `since_committed_id` on reconnect.
