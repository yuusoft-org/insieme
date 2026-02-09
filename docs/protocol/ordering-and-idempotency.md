# Ordering & Idempotency

This document defines `committed_id` ordering guarantees, deduplication semantics, payload equality, and broadcast-to-origin behavior.

## `committed_id` Ordering

- `committed_id` is **monotonic globally**, never reused, survives server restarts.
- `since_committed_id` in sync is **exclusive** (return events with `committed_id > since`).

## Deduplication by `id`

- The server must dedupe by `id` (global UUID). If the same `id` is submitted again, return the existing committed result instead of re-committing.
- If the same `id` is submitted with a **different payload**, reject with `validation_failed` and a descriptive error message.

## Payload Equality

- The server must compare payloads by a **stable canonical form** (sorted JSON or hash over normalized `partitions` + `event`).
- `client_id` is not part of the comparison — the `id` uniquely identifies the event regardless of which connection submits it.

## Client Idempotency

- Broadcasts include both `id` and `committed_id` to support client idempotency.
- Clients must handle receiving the same committed event multiple times (via sync, broadcast, or retry) without double-applying.

## Broadcast to Origin

- The server must send `event_committed` to the origin client.
- Additionally broadcasting `event_broadcast` to the origin client is **optional**; if it happens, the client must be idempotent by `id` / `committed_id`.
