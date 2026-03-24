# Ordering & Idempotency

This document defines global ordering and retry safety.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Global Ordering

- `committedId` **MUST** be globally monotonic.
- `committedId` **MUST NOT** be reused.
- `sinceCommittedId` in sync is exclusive (`committedId > since`).

## Dedupe by Event `id`

- Server **MUST** dedupe by `id` (global UUID).
- Retry with same `id` and same canonical payload **MUST** return the existing committed result.
- Retry with same `id` and different payload **MUST** be rejected (`validation_failed`).
- Dedupe retries **MUST NOT** allocate a new `committedId`.

## Canonical Payload Equality

Equality input is:

```yaml
canonical_input:
  partition: <single partition>
  projectId: <project id>
  userId: <optional user id>
  type: <event type>
  schemaVersion: <positive integer>
  payload: <event payload>
  meta: <event metadata, excluding clientId>
```

Rules:

- Exclude transport metadata (`msgId`, `timestamp`, `protocolVersion`).
- Exclude connection metadata.
- Server **MUST** use one deterministic canonicalization algorithm consistently.

Canonicalization algorithm (required):

1. Normalize `meta` and remove `meta.clientId` from the equality input.
2. Build `canonical_input = { partition, projectId, userId, type, schemaVersion, payload, meta }`.
3. Serialize `canonical_input` using deep key-sorted JSON:
   - object keys sorted lexicographically (ascending),
   - arrays preserve order,
   - primitive values preserved.
4. Compare canonical serialized bytes for equality.

## Origin Result vs Broadcast

- Origin connection's submit outcome is `submit_events_result`.
- Server **MUST NOT** broadcast committed events back to the same submitting connection.
- Clients **MUST** apply commits idempotently across submit result, sync, and broadcast paths.
