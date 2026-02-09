# Partitions

This document defines partition constraints, subscription management, and multi-partition event semantics.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Partition Constraints

- `partitions` **MUST** be a **non-empty array** of strings.
- `partitions` length **MUST** be <= 64 per event.
- Each partition name **MUST** be non-empty and <= 128 bytes UTF-8.
- Partition names **MUST** be normalized to Unicode NFC before validation/storage.
- Partition comparison **MUST** be case-sensitive and byte-exact after NFC normalization.
- Servers **MUST NOT** trim, case-fold, or otherwise rewrite partition strings beyond NFC normalization.
- Duplicates **MUST** be normalized away before storage.
- The server **MUST** treat `partitions` as a **set**: deduplicate and sort (ascending lexical byte order) before storage. Use the normalized array for hashing/equality checks.
- If limits are exceeded, server **MUST** reject with `validation_failed`.

### Legacy Field Migration (`partition` -> `partitions`)

- Wire protocol and durable storage **MUST** use `partitions` (array) as the canonical field.
- Legacy singular `partition` is deprecated and **MUST NOT** be emitted on the wire.
- Local adapter/runtime APIs **MAY** accept legacy `partition` input only as a compatibility shim by normalizing to `partitions: [partition]`.
- If both fields are provided and equivalent after normalization, implementations **MAY** accept and canonicalize to `partitions`.
- If both `partition` and `partitions` are provided and disagree, the request **MUST** be rejected with `bad_request`.

## Submission vs Subscription

- Subscription set controls which broadcasts a connection receives.
- Subscription set **MUST NOT** be treated as an authorization grant for submissions.

## Authorization Scope

- Subscription is a delivery filter, not an authorization mechanism.
- Server **MUST** authorize partition access separately for both submit and sync paths.
- For `submit_event`/`submit_events`, authorization is all-of across event partitions: client must be authorized for every partition in the event.
- For `sync`, if any requested partition is unauthorized, server **MUST** reject the request with `forbidden` and return no event data.

## Partition Subscriptions

Sync catch-up scope and broadcast subscription scope are distinct:

- `sync.payload.partitions`: which partitions to return events for in this sync request.
- `sync.payload.subscription_partitions` (optional): full replacement set for future broadcasts.

Rules:
1. If `subscription_partitions` is present, server **MUST** atomically replace the connection's subscription set with exactly that set.
2. If `subscription_partitions` is absent, server **MUST** keep existing subscriptions unchanged.
3. Server **MUST** return `effective_subscriptions` in `sync_response.payload`.
4. Clients **SHOULD** send `subscription_partitions` on first sync after connect.

### Adding Partitions

If a client adds a new partition, it **MUST** sync from `since_committed_id=0` for that partition's history.

### Removing Partitions

To leave partition P, send `subscription_partitions` that excludes P. Server **MUST** apply the replacement atomically. All subscriptions are removed on connection close.

## Multi-Partition Events

An event can belong to multiple partitions. When an event has `partitions: ["P1", "P2"]`:

- The event is visible in both P1 and P2 views.
- Broadcast is delivered to all clients whose subscription intersects the event's partitions.
- Per-partition state uses events whose partitions include that partition.

## Per-Partition Ordering

- `committed_id` is **global and monotonic**; per-partition ordering is the subsequence of committed events that include the partition.
- `committed_id` is unique **globally**.
- `id` (draft UUID) is used to match a local draft with its commit.
