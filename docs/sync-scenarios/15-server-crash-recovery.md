# Scenario 15 - Server Crash After Persist

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify recovery when server crashes after durable commit but before notifying clients.

## Actors
- C1 (origin)
- C2 (peer)
- Server

## Preconditions
- Server last `committedId=300`.
- C1 has local draft `id=evt-crash-1`.

## Steps

### 1) C1 submits draft
- Server validates and persists committed event with `committedId=301`.
- Server crashes before sending `submit_events_result` or broadcast.

### 2) Reconnect and sync
- C1 reconnects, syncs from `sinceCommittedId=300`, receives `evt-crash-1`.
- C1 inserts committed row and removes matching draft.
- C2 reconnects/syncs and also receives `evt-crash-1`.

### 3) Optional retry
- If C1 retries submit with same `id`, server dedupes and returns `committedId=301`.

## Assertions
- No duplicate commit is created.
- Both clients converge to committed event `301`.
