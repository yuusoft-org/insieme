# Scenario 16 - Offline Queue Drain + Catch-Up

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify offline drafts are drained in deterministic ordered batches and remain convergent with catch-up.

## Actors
- C1
- Server

## Preconditions
- C1 was offline and created drafts:
  - D1 (`draftClock=1`)
  - D2 (`draftClock=2`)
  - D3 (`draftClock=3`)
- Server may have additional remote commits during offline window.

## Steps

### 1) Reconnect catch-up
- C1 runs sync until `hasMore=false` and applies committed events.

### 2) Drain local queue
- C1 submits D1, D2, D3 in one or more `submit_events` batches.
- Batch payload order follows `(draftClock, id)`.
- Only one submit batch is in flight at a time.
- Server processes each batch in request order.
- If one item fails, later items in that same batch are returned as `not_processed` and remain drafts.

### 3) Apply outcomes
- For committed result: insert into `committed_events`, delete from `local_drafts`.
- For rejected result: delete from `local_drafts`.
- For `not_processed`: keep the draft for a later retry.

## Assertions
- Queue drain order is deterministic.
- Batch boundaries do not reorder drafts.
- Mixed outcomes are handled without inconsistent local state.
- Retries remain safe by `id` dedupe.
