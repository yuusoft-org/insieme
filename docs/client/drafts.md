# Drafts

This document defines the minimal client-side draft lifecycle for offline-first sync.

## Lifecycle

### 1) Create local draft

- Validate draft locally (best-effort UX validation).
- Insert into `local_drafts` with:
  - `id`
  - `draftClock` (storage-assigned monotonic order key)
  - `partitions`
  - `projectId` / `userId` when applicable
  - `type`
  - `schemaVersion`
  - `payload`
  - `meta`
- Apply draft immediately to local view (optimistic UI).

### 2) Submit

- Drain `local_drafts` ordered by `(draft_clock, id)`.
- Group consecutive drafts into one or more bounded `submit_events` batches.
- Preserve `(draft_clock, id)` order inside each batch.
- Keep at most one submit batch in flight per connection.

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

### 5) Deferred batch item

On `submit_events_result` with `status=not_processed`:

- Keep the matching row in `local_drafts`.
- Do not treat the item as committed or rejected.
- Retry it later in normal `(draftClock, id)` queue order.

### 6) Remote committed event

On `event_broadcast` or `sync_response.events`:

- Insert into `committed_events` idempotently.
- Remove matching local draft by `id` if present.
- Recompute effective view.

## Ordering Rules

- Committed state order: `ORDER BY committed_id` (`committedId` in JS).
- Draft overlay order: `ORDER BY draft_clock, id` (`draftClock` in JS).
- Effective state: committed state, then draft overlay.

## Retry / Idempotency

- Retries use the same event `id`.
- Server dedupes by `id`.
- Retry equality includes normalized `partitions`, `projectId`, `userId`, `type`, `schemaVersion`, `payload`, and `meta`.
- Batch retry still preserves the underlying draft order. If one item fails, later `not_processed` drafts stay queued for a later retry.
- Client apply path must be idempotent:
  - repeated committed insert -> no duplicate,
  - repeated draft cleanup -> safe no-op.

## Startup / Recovery

- Restore durable committed cursor.
- Run `sync` until `hasMore=false`.
- Retry remaining local drafts in `(draftClock, id)` order, in one or more bounded submit batches.
