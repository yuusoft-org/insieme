# Partitions

This document defines the minimal partition model for submit, sync, and broadcast.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Partition Shape

- `partitions` **MUST** be a non-empty array of strings.
- Each partition entry **MUST** be non-empty.
- Duplicate partition values in one event **MUST** be rejected with `validation_failed`.
- Partition order is not semantically significant. Server **MUST** normalize accepted partition sets to deterministic lexicographic order.

## Authorization

- Subscription/delivery behavior is not an authorization grant.
- Server **MUST** authorize partition access on every `submit_events` and `sync` request.
- Submit authorization is all-of: client must be authorized for every partition in the submitted event.
- If any requested sync partition is unauthorized, server **MUST** reject sync with `forbidden`.

## Sync Scope

- `sync.payload.partitions` defines both:
  - which partitions are returned in catch-up,
  - which partitions receive subsequent broadcasts for that connection.
- Server replaces the connection's active partition scope on each successful `sync` request.

## Multi-Partition Events

For `partitions: ["P1", "P2"]`:

- event is visible in both partition views,
- broadcast is delivered to connections whose active partition scope intersects the event partitions,
- per-partition ordering is the global `committed_id` subsequence.
