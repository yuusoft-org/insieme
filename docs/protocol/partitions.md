# Partitions

This document defines partition constraints, subscription management, and multi-partition event semantics.

## Partition Constraints

- `partitions` must be a **non-empty array** of strings.
- Max length: 64 partitions per event.
- Each partition name must be non-empty and <= 128 bytes UTF-8.
- Duplicates are normalized away before storage.
- The server treats `partitions` as a **set**: deduplicate and sort before storage. Use the normalized array for hashing/equality checks.
- If limits are exceeded, reject with `validation_failed`.

## Submission vs Subscription

- Subscription set controls which broadcasts a connection receives.
- It does **not** restrict which partitions a client may submit events for.

## Partition Subscriptions

Sync catch-up scope and broadcast subscription scope are distinct:

- `sync.payload.partitions`: which partitions to return events for in this sync request.
- `sync.payload.subscription_partitions` (optional): full replacement set for future broadcasts.

Rules:
1. If `subscription_partitions` is present, server must atomically replace the connection's subscription set with exactly that set.
2. If `subscription_partitions` is absent, server must keep existing subscriptions unchanged.
3. Server must return `effective_subscriptions` in `sync_response.payload`.
4. Clients should send `subscription_partitions` on first sync after connect.

### Adding Partitions

If a client adds a new partition, it must sync from `since_committed_id=0` for that partition's history.

### Removing Partitions

To leave partition P, send `subscription_partitions` that excludes P. Server must apply the replacement atomically. All subscriptions are removed on connection close.

## Multi-Partition Events

An event can belong to multiple partitions. When an event has `partitions: ["P1", "P2"]`:

- The event is visible in both P1 and P2 views.
- Broadcast is delivered to all clients whose subscription intersects the event's partitions.
- Per-partition state uses events whose partitions include that partition.

## Per-Partition Ordering

- `committed_id` is **global and monotonic**; per-partition ordering is the subsequence of committed events that include the partition.
- `committed_id` is unique **globally**.
- `id` (draft UUID) is used to match a local draft with its commit.
