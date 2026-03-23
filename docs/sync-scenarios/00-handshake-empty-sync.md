# Scenario 00 - Handshake + Empty Sync

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify a successful connect and an empty sync page.

## Actors
- C1
- Server

## Preconditions
- Server has no committed events for project `P1`.

## Steps

### 1) Connect

**C1 -> Server**
```yaml
type: connect
protocolVersion: "1.0"
payload:
  token: jwt
  clientId: C1
  projectId: P1
```

**Server -> C1**
```yaml
type: connected
protocolVersion: "1.0"
payload:
  clientId: C1
  projectId: P1
  projectLastCommittedId: 0
```

### 2) Sync

**C1 -> Server**
```yaml
type: sync
protocolVersion: "1.0"
payload:
  projectId: P1
  sinceCommittedId: 0
  limit: 50
```

**Server -> C1**
```yaml
type: sync_response
protocolVersion: "1.0"
payload:
  projectId: P1
  events: []
  nextSinceCommittedId: 0
  hasMore: false
  syncToCommittedId: 0
```

## Assertions
- Handshake succeeds.
- Empty sync is represented by `events: []` and `hasMore: false`.
- Durable cursor remains `0`.
