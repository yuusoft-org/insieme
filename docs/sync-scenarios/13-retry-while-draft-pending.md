# Scenario 13 - Retry While Draft Still Pending

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify idempotent recovery when original submit result was not received.

## Actors
- C1
- Server

## Preconditions
- Server already committed `id=evt-uuid-r1` at `committed_id=410`.
- C1 still has unresolved local draft row:
  - `id=evt-uuid-r1`
  - `draft_clock=5`

## Steps

### 1) C1 reconnects and syncs
- Sync since previous durable cursor returns committed event `evt-uuid-r1`.
- C1 inserts into `committed_events` and removes matching `local_drafts` row.

### 2) C1 may retry submit with same `id`
- Server dedupes and returns existing `committed_id=410`.
- Client apply is idempotent (no duplicates).

## Assertions
- Exactly one committed row exists for `evt-uuid-r1`.
- Local draft is resolved even if original result was lost.
