# Scenario 07 - Snapshot + Prune

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify snapshot usage and pruning of older committed events per partition.

## Actors
- C1
- Server

## Preconditions
- Partition: P1
- Snapshot exists for P1 at committed_id=500.
- Committed events for P1 exist for committed_id=501..505.
- Client also has pending drafts for P1.

## Steps

### 1) C1 loads snapshot
- Load snapshot(P1) state and committed_id=500.

### 2) C1 replays committed events after snapshot
- Query committed events where:
  - committed_id > 500
  - partitions includes P1
- Apply ordered by committed_id.

### 3) C1 overlays drafts
- Apply all draft rows for P1 ordered by (draft_clock, id).

### 4) Prune committed events (optional)
- After snapshot is confirmed, events with committed_id <= 500 can be pruned
  or archived for P1.

## Expected Results
- Local view state equals snapshot state + committed(>500) + drafts.
- Pruning does not change computed state (snapshot acts as base).

## Assertions
- If snapshot is missing or invalid, fall back to full replay.
- Draft overlay always happens after committed replay.
