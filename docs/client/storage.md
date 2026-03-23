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
  partition TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,            -- JSON object
  payload_compression TEXT DEFAULT NULL,
  client_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE committed_events (
  committed_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT,
  user_id TEXT,
  partition TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,            -- JSON object
  payload_compression TEXT DEFAULT NULL,
  client_ts INTEGER NOT NULL,
  server_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Notes:

- `id` is global event UUID and dedupe key.
- `draft_clock` is local ordering only.
- `schema_version` is required and mirrors public JS `schemaVersion`.
- Each draft/committed row stores exactly one `partition`.
- Built-in client stores are typically used per project, so the durable cursor is project-scoped by store instance.
- `client_ts` is the persisted form of `meta.clientTs`. Custom stores may persist richer draft metadata when needed.
- Public JS objects use camelCase; SQL adapters persist snake_case columns internally.
- `draft_clock` and `committed_id` primary keys already provide ordered access paths in SQLite/LibSQL.
- This rollout is intentionally not backward compatible with rows that predate `schemaVersion`; adapters may require reset or explicit backfill before opening legacy data.
- Reference adapters:
  - `src/sqlite-client-store.js` (`createSqliteClientStore`)
  - `src/libsql-client-store.js` (`createLibsqlClientStore`)

## Adapter Wiring

For `@libsql/client`:

```js
import { createClient } from "@libsql/client";
import { createLibsqlClientStore } from "insieme";

const client = createClient({ url: "file:./insieme-client.db" });
const store = createLibsqlClientStore(client);
```

## Optional Tables

Optional only when product requirements need them:

- `snapshots` for faster local startup,
- `rejected_drafts` for UI/audit history.
- `materialized_view_state` for partitioned derived state checkpoints.

Built-in SQL adapters also create:

```sql
CREATE TABLE materialized_view_state (
  view_name TEXT NOT NULL,
  partition TEXT NOT NULL,
  view_version TEXT NOT NULL,
  last_committed_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(view_name, partition)
);
```

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

- Persist one durable sync cursor per project-scoped client store: last applied `committedId`.
- In SQL adapters this lives in `app_state.key = 'cursor_committed_id'`.
- Use it as `sinceCommittedId` on reconnect.
