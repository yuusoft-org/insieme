# Scenario 11 - Multiple Drafts, Reordered Commit Results

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify local convergence when commit results return in different order than local draft order.

## Actors
- C1
- Server

## Preconditions
- `local_drafts` for `P1`:
  - D1: `id=evt-d1`, `draft_clock=1`
  - D2: `id=evt-d2`, `draft_clock=2`
  - D3: `id=evt-d3`, `draft_clock=3`
- Server last `committed_id=500`.

## Steps

### 1) C1 submits in draft order
- Submit D1, then D2, then D3 (one request each).

### 2) Server commit order differs
- D2 -> `committed_id=501`
- D1 -> `committed_id=502`
- D3 -> `committed_id=503`

### 3) C1 receives results in that order
- Resolve each by `id`:
  - insert committed row,
  - delete matching draft row.

## Assertions
- Draft rows are resolved by `id`, not assumed submit order.
- Final committed order is `501, 502, 503`.
- `local_drafts` is empty after all three results.
