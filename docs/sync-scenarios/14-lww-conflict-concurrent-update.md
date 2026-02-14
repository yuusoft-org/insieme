# Scenario 14 - LWW Conflict (Concurrent Update)

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify convergence under concurrent writes via server commit order.

## Actors
- C1
- C2
- Server

## Preconditions
- Both clients can write to `P1`.
- Both update the same logical entity.

## Steps

### 1) Concurrent submits
- C1 submits update U1 (`id=evt-c1`).
- C2 submits update U2 (`id=evt-c2`).

### 2) Server commit order
- Server commits U1 then U2 (or vice versa).
- Each commit gets unique `committed_id`.

### 3) Replication
- Origin clients get submit results.
- Peers get broadcasts.
- Reconnect clients receive same ordering through sync.

## Assertions
- All clients converge to state produced by highest `committed_id`.
- Outcome is deterministic regardless of local submit timing.
