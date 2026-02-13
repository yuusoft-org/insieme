# Scenario 10 - Origin Result and Peer Broadcast

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify single-mode submit outcome semantics:
- origin connection receives `submit_events_result`
- peer subscribers receive `event_broadcast`
- origin connection does not receive `event_broadcast` for its own submit

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
type: submit_events
payload:
  events:
    - id: evt-uuid-5
      client_id: C1
      partitions:
        - P1
      event:
        type: treeUpdate
        payload:
          target: explorer
```

### 2) Server commits and sends origin result

**Server -> C1 (commit)**
```yaml
type: submit_events_result
payload:
  results:
    - id: evt-uuid-5
      status: committed
      committed_id: 300
      status_updated_at: 1738451600000
```

### 3) Server broadcasts to peers only

**Server -> C2 (broadcast)**
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

Server does not send this `event_broadcast` to the origin connection C1.

### 4) Client handling

**C1**
- Receives `submit_events_result` and upgrades draft by id.
- Does not receive a same-item `event_broadcast`.

**C2**
- Inserts committed row by id.

## Expected Results
- Exactly one committed row exists for id=evt-uuid-5 on C1 and C2.
- No duplicate committed_id.
- Origin outcome is derived from `submit_events_result` only.

## Assertions
- Server sends `submit_events_result` to origin for submitted item.
- Server sends `event_broadcast` only to subscribed peer connections.
- Committed state remains correct on both clients.
