# Scenario 10 - Broadcast vs Origin Commit

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify idempotent handling when the origin client receives both commit response
and broadcast of the same event.

## Actors
- C1 (origin)
- C2 (peer)
- Server

## Preconditions
- C1 and C2 subscribed to ["P1"].
- C1 has a local draft id=evt-uuid-5.

## Steps

### 1) C1 submits event

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-uuid-5
  client_id: C1
  partitions:
    - P1
  event:
    type: treeUpdate
    payload:
      target: explorer
```

### 2) Server commits and sends both messages

**Server -> C1 (commit)**
```yaml
type: event_committed
payload:
  id: evt-uuid-5
  client_id: C1
  partitions:
    - P1
  committed_id: 300
  event:
    type: treeUpdate
    payload:
      target: explorer
  status_updated_at: 1738451600000
```

**Server -> C1 and C2 (broadcast)**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-5
  client_id: C1
  partitions:
    - P1
  committed_id: 300
  event:
    type: treeUpdate
    payload:
      target: explorer
  status_updated_at: 1738451600000
```

### 3) Client handling

**C1**
- Receives commit and upgrades draft by id.
- Receives broadcast and must be idempotent:
  - Update by id (no change) OR
  - Insert with ON CONFLICT(committed_id) DO NOTHING.

**C2**
- Inserts committed row by id.

## Expected Results
- Exactly one committed row exists for id=evt-uuid-5 on C1 and C2.
- No duplicate committed_id.

## Assertions
- Client logic is idempotent for commit + broadcast of same event.
- Committed state remains correct after both messages.
