# Scenario 10 - Origin Result vs Peer Broadcast

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify origin outcome comes from submit result; peers observe broadcast.

## Actors
- C1 (origin)
- C2 (peer)
- Server

## Preconditions
- C1 has local draft `id=evt-uuid-5`.
- C1 and C2 are connected with scope including `P1`.

## Steps

### 1) C1 submits draft
- Server commits as `committed_id=300`.

### 2) Delivery split
- Server sends `submit_events_result` to C1.
- Server sends `event_broadcast` to C2.
- Server does not broadcast this event back to C1.

## Assertions
- C1 resolves draft from `submit_events_result`.
- C2 inserts committed row from broadcast.
- Exactly one committed row exists per client for `id=evt-uuid-5`.
