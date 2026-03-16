# Scenario 01 - Local Draft Commit + Peer Broadcast

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify local draft resolution to committed and peer broadcast delivery.

## Actors
- C1 (origin)
- C2 (peer)
- Server

## Preconditions
- C1 and C2 are connected.
- C1 and C2 active partition scope includes `P1`.
- Server last `committedId` is 100.
- C1 has a local draft row `id=evt-uuid-1` in `local_drafts`.

## Steps

### 1) C1 submits draft

**C1 -> Server**
```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [P1]
      projectId: P1
      userId: U1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: A, parentId: _root, index: 0 }
      meta:
        clientId: C1
        clientTs: 1738451204000
```

### 2) Server commits
- Validate payload + authorization.
- Assign `committedId=101`.
- Persist event durably.

### 3) Server responds and broadcasts

**Server -> C1**
```yaml
type: submit_events_result
protocolVersion: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committedId: 101
      created: 1738451205000
```

**Server -> C2**
```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 101
  id: evt-uuid-1
  partitions: [P1]
  projectId: P1
  userId: U1
  type: explorer.folderCreated
  schemaVersion: 1
  payload: { id: A, parentId: _root, index: 0 }
  meta:
    clientId: C1
    clientTs: 1738451204000
  created: 1738451205000
```

## Assertions
- C1 inserts committed row in `committed_events` and removes `evt-uuid-1` from `local_drafts`.
- C2 inserts committed row in `committed_events`.
- No duplicate committed rows for this event.
