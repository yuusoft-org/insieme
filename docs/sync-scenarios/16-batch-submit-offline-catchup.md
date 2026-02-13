# Scenario 16 - Offline Queue Drain + Catch-Up

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify offline drafts are drained sequentially in core mode and remain convergent with catch-up.

## Actors
- C1
- Server

## Preconditions
- C1 was offline and created drafts:
  - D1 (`draft_clock=1`)
  - D2 (`draft_clock=2`)
  - D3 (`draft_clock=3`)
- Server may have additional remote commits during offline window.

## Steps

### 1) Reconnect catch-up
- C1 runs sync until `has_more=false` and applies committed events.

### 2) Drain local queue
- C1 submits D1, D2, D3 one-by-one in `(draft_clock, id)` order.
- Server may commit/reject each independently.

### 3) Apply outcomes
- For committed result: insert into `committed_events`, delete from `local_drafts`.
- For rejected result: delete from `local_drafts`.

## Assertions
- Queue drain order is deterministic.
- Mixed outcomes are handled without inconsistent local state.
- Retries remain safe by `id` dedupe.
