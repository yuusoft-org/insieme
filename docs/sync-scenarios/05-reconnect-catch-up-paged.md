# Scenario 05 - Reconnect Catch-Up (Paged)

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify paged sync after reconnect, proper commit ordering, and broadcast handling during an active sync cycle.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- Server has committed events 121..125 (global).
- All those events include partition "P1".
- C1 last_committed_id = 120.
- C1 has local drafts still pending.

## Steps

### 1) C1 reconnects

**C1 -> Server**
```yaml
type: connect
payload:
  token: jwt
  client_id: C1
  last_committed_id: 120
```

**Server -> C1**
```yaml
type: connected
payload:
  client_id: C1
  server_time: 1738451300000
  server_last_committed_id: 125
  capabilities:
    profile: compatibility
    accepted_event_types:
      - set
      - unset
      - treePush
      - treeDelete
      - treeUpdate
      - treeMove
    tree_policy: strict
```

### 2) C1 syncs with pagination

**C1 -> Server**
```yaml
type: sync
payload:
  partitions:
    - P1
  subscription_partitions:
    - P1
  since_committed_id: 120
  limit: 2
```

**Server -> C1 (page 1)**
```yaml
type: sync_response
payload:
  partitions:
    - P1
  effective_subscriptions:
    - P1
  events:
    - committed_id: 121
    - committed_id: 122
  next_since_committed_id: 122
  sync_to_committed_id: 125
  has_more: true
```

### 2a) Concurrent broadcast arrives during active sync

Server commits a new event with `committed_id=126` while C1 is still paging to `sync_to_committed_id=125`.

**Server -> C1**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-126
  client_id: C9
  partitions:
    - P1
  committed_id: 126
  event:
    type: treeUpdate
    payload:
      target: explorer
  status_updated_at: 1738451300500
```

**C1 behavior**
- 126 > sync_to_committed_id (125), so buffer this broadcast.
- Do not apply until the page with `has_more=false` is processed.

**C1 -> Server (page 2)**
```yaml
type: sync
payload:
  partitions:
    - P1
  since_committed_id: 122
  limit: 2
```

**Server -> C1 (page 2)**
```yaml
type: sync_response
payload:
  partitions:
    - P1
  effective_subscriptions:
    - P1
  events:
    - committed_id: 123
    - committed_id: 124
  next_since_committed_id: 124
  sync_to_committed_id: 125
  has_more: true
```

**C1 -> Server (page 3)**
```yaml
type: sync
payload:
  partitions:
    - P1
  since_committed_id: 124
  limit: 2
```

**Server -> C1 (page 3)**
```yaml
type: sync_response
payload:
  partitions:
    - P1
  effective_subscriptions:
    - P1
  events:
    - committed_id: 125
  next_since_committed_id: 125
  sync_to_committed_id: 125
  has_more: false
```

### 3) C1 inserts committed rows and flushes buffer
- Insert each event by id (idempotent if already present).
- After final page, flush buffered broadcast 126 and apply it.

### 4) C1 rebuilds local view
- committed(P1) = events 121..126 (ordered)
- drafts(P1) re-applied on top

## Assertions
- All missing committed events are inserted exactly once.
- Buffered broadcast (126) is applied after sync completes, not during.
- Local view state is correct after rebase.
- Pagination stops when has_more=false.
- sync_to_committed_id remains 125 across all three pages.
