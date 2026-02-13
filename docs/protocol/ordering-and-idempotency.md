# Ordering & Idempotency

This document defines `committed_id` ordering guarantees, deduplication semantics, payload equality, and origin/broadcast behavior.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## `committed_id` Ordering

- `committed_id` **MUST** be monotonic globally, never reused, and survive server restarts.
- `since_committed_id` in sync is **exclusive**: server **MUST** return events with `committed_id > since`.

## Deduplication by `id`

- The server **MUST** dedupe by `id` (global UUID). If the same `id` is submitted again, return the existing committed result instead of re-committing.
- If the same `id` is submitted with a **different payload**, the server **MUST** reject with `validation_failed` and a descriptive error message.
- When deduping a same-`id`, same-payload retry, the server **MUST NOT** allocate a new `committed_id`.
- Duplicate `id` values inside a single `submit_events` request are invalid request shape and **MUST** be rejected as `bad_request` before item processing.

## Payload Equality

- The server **MUST** compare payloads by a **stable canonical form** (sorted JSON or hash over normalized `partitions` + `event`).
- `client_id` is not part of the comparison — the `id` uniquely identifies the event regardless of which connection submits it.

### Canonicalization Algorithm

To make equality deterministic across implementations, servers **MUST** compute equality over:

```yaml
canonical_input:
  partitions: <normalized_partitions_set>
  event: <event_object>
```

Rules:
- `normalized_partitions_set` is the post-normalization value from `partitions.md` (NFC normalized, deduped, sorted).
- `client_id`, transport envelope fields (`msg_id`, `timestamp`, `protocol_version`), and connection metadata are excluded.
- Canonical JSON serialization **MUST** use RFC 8785 JSON Canonicalization Scheme (JCS) semantics.
- Equality is byte-equality of canonical JSON output, or equality of a cryptographic hash (e.g., SHA-256) of that canonical output.

## Client Idempotency

- Broadcasts include both `id` and `committed_id` to support client idempotency.
- Clients **MUST** handle receiving the same committed event multiple times (via sync, broadcast, or retry) without double-applying.

## Origin Result and Broadcast

- The server **MUST** send one `submit_events_result` for each `submit_events` request, with one result entry per submitted item in input order.
- The server **MUST NOT** send `event_broadcast` for an item to the same connection that submitted that item.
- The origin client's authoritative submit outcome is `submit_events_result`.
