# Scenario 01 - Local Draft Commit + Peer Broadcast

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify local draft resolution to committed and peer broadcast delivery.

## Actors
- C1 (origin)
- C2 (peer)
- Server

## Preconditions
- C1 and C2 are connected.
- C1 and C2 active partition scope includes `P1`.
- Server last `committed_id` is 100.
- C1 has a local draft row `id=evt-uuid-1` in `local_drafts`.

## Steps

### 1) C1 submits draft

**C1 -> Server**
```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [P1]
      event:
        type: treePush
        payload:
          target: explorer
          value: { id: A }
          options: { parent: _root, position: first }
```

### 2) Server commits
- Validate payload + authorization.
- Assign `committed_id=101`.
- Persist event durably.

### 3) Server responds and broadcasts

**Server -> C1**
```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committed_id: 101
      status_updated_at: 1738451205000
```

**Server -> C2**
```yaml
type: event_broadcast
protocol_version: "1.0"
payload:
  id: evt-uuid-1
  client_id: C1
  partitions: [P1]
  committed_id: 101
  event:
    type: treePush
    payload:
      target: explorer
      value: { id: A }
      options: { parent: _root, position: first }
  status_updated_at: 1738451205000
```

## Assertions
- C1 inserts committed row in `committed_events` and removes `evt-uuid-1` from `local_drafts`.
- C2 inserts committed row in `committed_events`.
- No duplicate committed rows for this event.
