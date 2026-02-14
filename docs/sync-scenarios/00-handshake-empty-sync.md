# Scenario 00 - Handshake + Empty Sync

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify a successful connect and an empty sync page.

## Actors
- C1
- Server

## Preconditions
- Server has no committed events for `P1`.

## Steps

### 1) Connect

**C1 -> Server**
```yaml
type: connect
protocol_version: "1.0"
payload:
  token: jwt
  client_id: C1
```

**Server -> C1**
```yaml
type: connected
protocol_version: "1.0"
payload:
  client_id: C1
  server_last_committed_id: 0
```

### 2) Sync

**C1 -> Server**
```yaml
type: sync
protocol_version: "1.0"
payload:
  partitions: [P1]
  since_committed_id: 0
  limit: 50
```

**Server -> C1**
```yaml
type: sync_response
protocol_version: "1.0"
payload:
  partitions: [P1]
  events: []
  next_since_committed_id: 0
  has_more: false
```

## Assertions
- Handshake succeeds.
- Empty sync is represented by `events: []` and `has_more: false`.
- Durable cursor remains `0`.
