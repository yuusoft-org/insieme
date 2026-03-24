# Scenario 05 - Reconnect Catch-Up (Paged)

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify paged sync catch-up and simplified broadcast behavior during active sync.

## Actors
- C1
- Server

## Preconditions
- C1 durable cursor is `120`.
- Server has committed events `121..125` for project `P1`.
- Sync page size is `2`.

## Steps

### 1) Reconnect + first page

**C1 -> Server**
```yaml
type: sync
protocolVersion: "1.0"
payload:
  projectId: P1
  sinceCommittedId: 120
  limit: 2
```

**Server -> C1**
```yaml
type: sync_response
protocolVersion: "1.0"
payload:
  projectId: P1
  events:
    - committedId: 121
      id: evt-121
      partition: P1
      projectId: P1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: A }
      meta: { clientId: C2, clientTs: 1738451201000 }
      serverTs: 1738451202000
    - committedId: 122
      id: evt-122
      partition: P1
      projectId: P1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: B }
      meta: { clientId: C2, clientTs: 1738451203000 }
      serverTs: 1738451204000
  nextSinceCommittedId: 122
  hasMore: true
  syncToCommittedId: 125
```

### 2) More pages
- Second page returns `[123, 124]`, `nextSinceCommittedId: 124`, `hasMore: true`.
- Third page returns `[125]`, `nextSinceCommittedId: 125`, `hasMore: false`.

### 3) Broadcast suppression during active sync
- While `hasMore=true`, server does not send `event_broadcast` to C1.
- After final page (`hasMore=false`), normal broadcasts resume.

## Assertions
- C1 applies all committed events in `committedId` order.
- Durable cursor is updated to `125` only after final page is persisted.
- No client-side broadcast buffering is required.
