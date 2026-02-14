# Ordering & Idempotency

This document defines global ordering and retry safety.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Global Ordering

- `committed_id` **MUST** be globally monotonic.
- `committed_id` **MUST NOT** be reused.
- `since_committed_id` in sync is exclusive (`committed_id > since`).

## Dedupe by Event `id`

- Server **MUST** dedupe by `id` (global UUID).
- Retry with same `id` and same canonical payload **MUST** return the existing committed result.
- Retry with same `id` and different payload **MUST** be rejected (`validation_failed`).
- Dedupe retries **MUST NOT** allocate a new `committed_id`.

## Canonical Payload Equality

Equality input is:

```yaml
canonical_input:
  partitions: <normalized partition set>
  event: <event object>
```

Rules:

- Exclude transport metadata (`msg_id`, `timestamp`, `protocol_version`).
- Exclude connection metadata.
- Server **MUST** use one deterministic canonicalization algorithm consistently.

Canonicalization algorithm (required):

1. Normalize `partitions` as a set sorted lexicographically (ascending, code-point order).
2. Build `canonical_input = { partitions: normalizedPartitions, event }`.
3. Serialize `canonical_input` using deep key-sorted JSON:
   - object keys sorted lexicographically (ascending),
   - arrays preserve order,
   - primitive values preserved.
4. Compare canonical serialized bytes for equality.

## Origin Result vs Broadcast

- Origin connection's submit outcome is `submit_events_result`.
- Server **MUST NOT** broadcast committed events back to the same submitting connection.
- Clients **MUST** apply commits idempotently across submit result, sync, and broadcast paths.
