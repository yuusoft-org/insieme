# Scenario 12 - Add Partition Mid-Session

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify adding a new partition without dropping existing broadcast subscriptions.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- C1 is connected and subscribed to ["P1"].
- C1 has cursor for P1 up to committed_id=800.
- C1 has never synced P2.
- Server global committed_id = 800.
- Server has committed events for P2 at committed_id 50, 120, and 350.

## Steps

### 1) C1 sends sync for P2 with updated subscriptions

**C1 -> Server**
```yaml
type: sync
payload:
  partitions:
    - P2
  subscription_partitions:
    - P1
    - P2
  since_committed_id: 0
  limit: 500
```

Note: `partitions` requests P2 history only. `subscription_partitions` replaces the full broadcast set to include both P1 and P2.

### 2) Server returns P2 history

**Server -> C1**
```yaml
type: sync_response
payload:
  partitions:
    - P2
  effective_subscriptions:
    - P1
    - P2
  events:
    - id: evt-uuid-50
      client_id: C5
      partitions:
        - P2
      committed_id: 50
      event:
        type: treePush
        payload:
          target: sidebar
          value:
            id: s1
          options:
            parent: _root
            position: first
      status_updated_at: 1738440000000
    - id: evt-uuid-120
      client_id: C5
      partitions:
        - P2
      committed_id: 120
      event:
        type: treePush
        payload:
          target: sidebar
          value:
            id: s2
          options:
            parent: _root
            position: first
      status_updated_at: 1738441000000
    - id: evt-uuid-350
      client_id: C7
      partitions:
        - P2
      committed_id: 350
      event:
        type: treeUpdate
        payload:
          target: sidebar
          value:
            name: Updated
          options:
            id: s1
      status_updated_at: 1738445000000
  next_since_committed_id: 350
  sync_to_committed_id: 800
  has_more: false
```

### 3) C1 continues receiving P1 broadcasts

A new event is committed on P1 after the sync completes.

**Server -> C1**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-801
  client_id: C3
  partitions:
    - P1
  committed_id: 801
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: new-item
      options:
        parent: _root
        position: first
  status_updated_at: 1738451700000
```

C1 applies this broadcast normally — P1 subscription was not lost.

### 4) C1 also receives P2 broadcasts going forward

**Server -> C1**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-802
  client_id: C5
  partitions:
    - P2
  committed_id: 802
  event:
    type: treeUpdate
    payload:
      target: sidebar
      value:
        name: Renamed
      options:
        id: s2
  status_updated_at: 1738451800000
```

## Assertions
- C1 does not lose P1 subscription while adding P2.
- P2 state is built from full history (`since_committed_id=0`).
- `effective_subscriptions` in sync_response is exactly ["P1", "P2"].
- After sync, C1 receives broadcasts for both P1 and P2.
- P1 committed state is unaffected by the P2 sync.
