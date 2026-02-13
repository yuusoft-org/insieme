# Drafts

This document defines the minimal client-side draft lifecycle for offline-first sync.

## Lifecycle

### 1) Create local draft

- Validate draft locally (best-effort UX validation).
- Insert into `local_drafts` with:
  - `id`
  - `draft_clock` (storage-assigned monotonic order key)
  - `partitions`
  - `event`
- Apply draft immediately to local view (optimistic UI).

### 2) Submit

- Drain `local_drafts` ordered by `(draft_clock, id)`.
- Send one `submit_events` request per draft (core mode).

### 3) Commit result

On `submit_events_result` with `status=committed`:

- Insert committed row into `committed_events`.
- Remove matching row from `local_drafts`.
- Recompute effective view: committed + remaining drafts.

### 4) Reject result

On `submit_events_result` with `status=rejected`:

- Remove matching row from `local_drafts`.
- Optionally store rejected history in a separate app table.
- Recompute effective view.

### 5) Remote committed event

On `event_broadcast` or `sync_response.events`:

- Insert into `committed_events` idempotently.
- Remove matching local draft by `id` if present.
- Recompute effective view.

## Ordering Rules

- Committed state order: `ORDER BY committed_id`.
- Draft overlay order: `ORDER BY draft_clock, id`.
- Effective state: committed state, then draft overlay.

## Retry / Idempotency

- Retries use the same event `id`.
- Server dedupes by `id`.
- Client apply path must be idempotent:
  - repeated committed insert -> no duplicate,
  - repeated draft cleanup -> safe no-op.

## Startup / Recovery

- Restore durable committed cursor.
- Run `sync` until `has_more=false`.
- Retry remaining local drafts in `(draft_clock, id)` order.
