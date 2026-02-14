# Scenario 17 - Transport Close + Reconnect

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify behavior when transport drops and client reconnects (core mode has no protocol heartbeat/disconnect messages).

## Actors
- C1
- C2
- Server

## Preconditions
- C1 and C2 connected and synced on `P1`.

## Steps

### 1) Normal operation
- C1 submits and receives committed result.
- C2 receives broadcast.

### 2) Transport drop
- C1 connection closes unexpectedly.

### 3) Reconnect
- C1 reconnects with `connect`.
- C1 runs `sync` from durable cursor.
- C1 resumes submit flow.

## Assertions
- Reconnect + sync restores consistency after transport loss.
- No protocol-level heartbeat/disconnect dependency exists in core mode.
