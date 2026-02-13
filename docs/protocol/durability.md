# Durability

This document defines the server event flow, sync/catch-up semantics, persistence guarantees, storage expectations, retention, and limits.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Server Flow

### Submit Events

1. Receive `submit_events`.
2. Validate payload and authorization (event profile/canonical and tree profile/compatibility).
3. If invalid or unauthorized, mark that item as `status=rejected` in `submit_events_result`. No broadcast occurs on rejection.
4. If valid → assign `committed_id` (global, monotonic).
5. Persist the committed event (durable write).
6. After all items are processed, send one `submit_events_result` to the origin client.
7. Broadcast `event_broadcast` to all other clients whose subscriptions intersect the event's partitions.

For each valid item, steps 4, 5, and 7 **MUST** occur in this order.
Step 6 occurs once per `submit_events` request after all items are processed.

For `submit_events`:
- Server **MUST** pre-validate request-level invariants before processing any item (for example: unique `payload.events[].id`).
- Server **MUST** apply the same flow per item in request order.
- Server **MUST** return one result entry per submitted item in `submit_events_result`, preserving input order.
- Batch execution is non-atomic: a failed item **MUST NOT** roll back already committed prior items.

## Sync / Catch-Up

When a client connects (or reconnects), it sends `sync` with its last known `committed_id`. The server **MUST** return all committed events with `committed_id > since_committed_id` whose partitions intersect the requested partitions.

If any requested partition is unauthorized, server **MUST** reject the sync request with `forbidden` and return no event data.

- The server **MAY** respond in multiple pages using `limit` + `has_more`.
- Clients **MUST** continue paging until `has_more=false`.
- The server **MUST** include `sync_to_committed_id` (high-watermark when the cycle started) and keep it constant across all pages.
- Clients **MUST NOT** send concurrent `sync` requests on the same connection. Wait for each `sync_response` before sending the next `sync`.

### Sync Acknowledgment

`sync_response` is intentionally unacknowledged. Client **MUST** durably persist applied events and `next_since_committed_id` before considering the page complete. If the client crashes before persisting, it re-requests from its last durable cursor. Server idempotency guarantees correctness.

### Broadcast Handling During Sync

While a sync cycle is active (between the first `sync` request and the final `sync_response` with `has_more=false`):

- Apply `sync_response.events` immediately (idempotent by `id`/`committed_id`).
- If an `event_broadcast` arrives with `committed_id <= sync_to_committed_id`, apply idempotently (ignore if already present from sync).
- If an `event_broadcast` arrives with `committed_id > sync_to_committed_id`, buffer it until the cycle completes.
- After the final page, flush buffered broadcasts in `committed_id` order.
- If the buffer is lost (crash/restart), re-sync from the last durable cursor.

All five rules above are **MUST** requirements.

### Future Cursor Validation

If `since_committed_id` is higher than the server's current max committed_id, the server **MUST** return an empty `sync_response` with `has_more=false` and `sync_to_committed_id` set to the server's actual max. The client can detect the mismatch and trigger a full re-sync if needed.

## Durability Guarantees

- `submit_events_result` committed entries and `event_broadcast` **MUST** only be sent **after** the committed event is durably persisted.
- On server restart, the commit log is the source of truth for replay and sync. In-memory subscription state is rebuilt from active connections (clients **MUST** reconnect and re-sync).
- If the server crashes between durable persist and broadcast, the origin client never receives confirmation. On reconnect, the client retries pending drafts; the server dedupes by `id` and returns the existing committed result. Peers receive the event on their next sync.

## Storage Expectations

Server storage is **committed-only**:

- Append-only log of committed events.
- Index by `committed_id`.
- Store `partitions` as an array; optionally maintain an `event_partitions(id, partition)` index for fast membership queries.
- Snapshots are optional (committed-only) to speed up sync.

## Retention / Compaction

- Because events can belong to multiple partitions, an event **MUST NOT** be pruned until **all** referenced partitions have advanced past its `committed_id` (or equivalent retention policy).

## Limits & Backpressure

- Server **SHOULD** enforce a max message size (implementation-defined).
- Server **SHOULD** cap in-flight drafts per client (implementation-defined).
- `sync.payload.limit` **MUST** be clamped to server bounds:
  - use advertised `limits.sync_limit_min` / `limits.sync_limit_max` when present,
  - otherwise use default bounds [50, 1000].
  If client sends a value outside bounds, server **MUST** coerce to the nearest bound.
- On overload, server **SHOULD** return `rate_limited` and **MAY** close the connection.
