# Scenario 00 - Handshake and Empty Sync

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify a clean initial connection with no committed events and no drafts.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- Server has no committed events (global last committed_id = 0).
- C1 has an empty local DB.
- C1 subscribes to partitions: ["P1"].

## Steps

### 1) Client connects (JWT validation only)

**C1 -> Server**
```yaml
type: connect
payload:
  token: jwt
  client_id: C1
  last_committed_id: 0
```

**Server behavior**
- Validate JWT signature and expiry.
- Ensure token client_id matches payload client_id.
- Accept connection.

**Server -> C1**
```yaml
type: connected
payload:
  client_id: C1
  server_time: 1738451200000
  server_last_committed_id: 0
```

### 2) Client requests sync

**C1 -> Server**
```yaml
type: sync
payload:
  partitions:
    - P1
  subscription_partitions:
    - P1
  since_committed_id: 0
  limit: 500
```

**Server -> C1**
```yaml
type: sync_response
payload:
  partitions:
    - P1
  effective_subscriptions:
    - P1
  events: []
  next_since_committed_id: 0
  sync_to_committed_id: 0
  has_more: false
```

## Expected Local DB State (C1)
- No rows in `events`.
- `draft_clock` remains unchanged.

## Expected Local View State (P1)
- committed(P1) = []
- drafts(P1) = []
- local view state = empty

## Assertions
- No committed events are inserted.
- No drafts are created.
- sync_response is empty and has_more = false.
- effective_subscriptions includes P1.
