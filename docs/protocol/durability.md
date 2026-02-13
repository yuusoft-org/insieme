# Durability

This document defines submit flow, sync paging, and persistence guarantees.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Submit Flow

For each `submit_events` request (core mode: one item):

1. Validate request shape.
2. Validate authorization and event payload.
3. If rejected, return `submit_events_result` with `status=rejected`.
4. If accepted, assign next global `committed_id`.
5. Persist committed event durably.
6. Return `submit_events_result` with `status=committed`.
7. Broadcast `event_broadcast` to other subscribed clients.

Required ordering for accepted items:

- assign `committed_id` -> durable persist -> send result/broadcast.

## Sync / Catch-Up

- Client sends `sync` with `since_committed_id` (exclusive).
- Server returns events with `committed_id > since_committed_id` intersecting requested partitions.
- Paging uses `limit` + `has_more`.
- Client continues paging until `has_more=false`.

Cursor rule:

- `next_since_committed_id` from each page is the input cursor for the next page.
- Final `next_since_committed_id` is the client's durable cursor.

## Broadcast During Sync (Simplified Rule)

To minimize client complexity:

- While a connection has an active sync cycle (`has_more=true` pages pending), server **MUST NOT** send `event_broadcast` to that connection.
- After final sync page (`has_more=false`), server resumes broadcasts.

This removes the need for client-side high-watermark buffering logic.

## Durability Guarantees

- Committed results and broadcasts **MUST** only be sent after durable persist.
- On server restart, committed storage is the source of truth.
- If crash occurs after persist but before reply, client retries with same `id`; server dedupe returns existing commit.

## Storage Expectations

Server storage is committed-only:

- append-only committed log,
- unique index on `committed_id`,
- unique dedupe index on `id`.

Snapshots are optional.

## Limits

- Server **MAY** enforce max message size and request rate.
- `sync.limit` **MUST** be clamped to server bounds.
