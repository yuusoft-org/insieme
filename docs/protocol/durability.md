# Durability

This document defines the server event flow, sync/catch-up semantics, persistence guarantees, storage expectations, retention, and limits.

## Server Flow

### Submit Event

1. Receive `submit_event` (or `submit_events` for batch).
2. Validate payload (tree or model mode).
3. If invalid → send `event_rejected` to origin client. No broadcast occurs on rejection.
4. If valid → assign `committed_id` (global, monotonic).
5. Persist the committed event (durable write).
6. Send `event_committed` to origin client.
7. Broadcast `event_broadcast` to all other clients whose subscriptions intersect the event's partitions.

## Sync / Catch-Up

When a client connects (or reconnects), it sends `sync` with its last known `committed_id`. The server returns all committed events **after** that id whose partitions intersect the requested partitions.

- If there are many events, respond in **pages** with `limit` + `has_more`.
- Clients loop until `has_more=false`.
- The server must include `sync_to_committed_id` (high-watermark when the cycle started) and keep it constant across all pages.
- Clients must not send concurrent `sync` requests on the same connection. Wait for each `sync_response` before sending the next `sync`.

### Sync Acknowledgment

`sync_response` is intentionally unacknowledged. Client must durably persist applied events and `next_since_committed_id` before considering the page complete. If the client crashes before persisting, it re-requests from its last durable cursor. Server idempotency guarantees correctness.

### Broadcast Handling During Sync

While a sync cycle is active (between the first `sync` request and the final `sync_response` with `has_more=false`):

- Apply `sync_response.events` immediately (idempotent by `id`/`committed_id`).
- If an `event_broadcast` arrives with `committed_id <= sync_to_committed_id`, apply idempotently (ignore if already present from sync).
- If an `event_broadcast` arrives with `committed_id > sync_to_committed_id`, buffer it until the cycle completes.
- After the final page, flush buffered broadcasts in `committed_id` order.
- If the buffer is lost (crash/restart), re-sync from the last durable cursor.

### Future Cursor Validation

If `since_committed_id` is higher than the server's current max committed_id, the server should return an empty `sync_response` with `has_more=false` and `sync_to_committed_id` set to the server's actual max. The client can detect the mismatch and trigger a full re-sync if needed.

## Durability Guarantees

- `event_committed` / `event_broadcast` must only be sent **after** the committed event is durably persisted.
- On server restart, the commit log is the source of truth for replay and sync. In-memory subscription state is rebuilt from active connections (clients must reconnect and re-sync).
- If the server crashes between durable persist and broadcast, the origin client never receives confirmation. On reconnect, the client retries pending drafts; the server dedupes by `id` and returns the existing committed result. Peers receive the event on their next sync.

## Storage Expectations

Server storage is **committed-only**:

- Append-only log of committed events.
- Index by `committed_id`.
- Store `partitions` as an array; optionally maintain an `event_partitions(id, partition)` index for fast membership queries.
- Optional snapshots (committed-only) to speed up sync.

## Retention / Compaction

- Because events can belong to multiple partitions, an event should only be pruned when **all** referenced partitions have advanced past its `committed_id` (or equivalent retention policy).

## Limits & Backpressure

- Server should enforce a max message size (implementation-defined).
- Server should cap in-flight drafts per client (implementation-defined).
- `sync.payload.limit` must be clamped to [50, 1000]. If client sends a value outside this range, server should coerce to the nearest bound.
- On overload, server returns `rate_limited` and may close the connection.
