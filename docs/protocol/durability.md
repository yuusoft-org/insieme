# Durability

This document defines submit flow, sync paging, and persistence guarantees.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Submit Flow

For each `submit_events` request:

1. Validate request shape.
2. Process submitted items in request order.
3. Validate authorization and event payload for the current item.
4. If an item is rejected, add `status=rejected` for that item, stop the batch, and mark each later submitted item as `status=not_processed`.
5. If an item is accepted, assign the next global `committedId`.
6. Persist each committed event durably.
7. Return one `submit_events_result` containing per-item outcomes in request order.
8. Broadcast `event_broadcast` to other subscribed clients for committed items only.

Required ordering for accepted items:

- assign `committedId` -> durable persist -> send result/broadcast.
- accepted items within one batch **MUST** preserve request order.
- later messages on the same connection **MUST NOT** overtake an earlier `submit_events` batch.

## Sync / Catch-Up

- Client sends `sync` with `sinceCommittedId` (exclusive).
- Server returns events with `committedId > sinceCommittedId` intersecting requested partitions.
- Paging uses `limit` + `hasMore`.
- Client continues paging until `hasMore=false`.
- Server **MUST** use a fixed per-cycle upper bound (`syncToCommittedId`) captured at the first page so paging converges to completion.
- Events committed after `syncToCommittedId` are delivered after the cycle (broadcast or next sync cycle).

Cursor rule:

- `nextSinceCommittedId` from each page is the input cursor for the next page.
- Final `nextSinceCommittedId` is the client's durable cursor.
- Client **MAY** persist intermediate page cursors, but **MUST** persist the final cursor when `hasMore=false`.

## Broadcast During Sync (Simplified Rule)

To minimize client complexity:

- While a connection has an active sync cycle (`hasMore=true` pages pending), server **MUST NOT** send `event_broadcast` to that connection.
- After final sync page (`hasMore=false`), server resumes broadcasts.

This removes the need for client-side high-watermark buffering logic.

## Durability Guarantees

- Committed results and broadcasts **MUST** only be sent after durable persist.
- On server restart, committed storage is the source of truth.
- If crash occurs after persist but before reply, client retries with same `id`; server dedupe returns existing commit.
- `not_processed` items are not attempted and therefore remain client-side drafts until a later retry.

## Storage Expectations

Server storage is committed-only:

- append-only committed log,
- unique index on `committedId`,
- unique dedupe index on `id`.

Snapshots are optional.

## Limits

- Server **MAY** enforce max message size and request rate.
- `sync.limit` **MUST** be clamped to server bounds.
- Core default bounds are:
  - default: `500` when omitted,
  - min: `1`,
  - max: `1000`.
