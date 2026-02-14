# Scenario 07 - Snapshot + Prune (Optional)

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify optional snapshot-based replay optimization and safe prune boundary.

## Actors
- C1

## Preconditions
- Local snapshot exists for `P1` at `committed_id=500`.
- `committed_events` includes `501..505` for `P1`.
- `local_drafts` may contain pending drafts for `P1`.

## Steps

### 1) Rebuild effective state
- Load snapshot state at 500.
- Replay committed rows where `committed_id > 500` ordered by `committed_id`.
- Apply draft overlay ordered by `(draft_clock, id)`.

### 2) Optional prune
- If snapshot is confirmed durable, prune committed rows `<=500` for this partition according to retention policy.

## Assertions
- Effective state equals full replay result.
- Prune never removes rows needed by active retention policy.
