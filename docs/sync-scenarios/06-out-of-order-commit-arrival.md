# Scenario 06 - Out-of-Order Commit Arrival

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify correct ordering when committed events arrive out of order.

## Actors
- C1
- Server

## Preconditions
- C1 is connected and subscribed to ["P1"].
- Two committed events exist on server:
  - committed_id=129 (id=evt-uuid-129)
  - committed_id=130 (id=evt-uuid-130)
- Network delivers 130 before 129.

## Steps

### 1) C1 receives committed_id=130 first

**Server -> C1**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-130
  client_id: C2
  partitions:
    - P1
  committed_id: 130
  event:
    type: treeUpdate
    payload:
      target: explorer
  status_updated_at: 1738451400000
```

**C1 inserts row**
```
id=evt-uuid-130
committed_id=130
status=committed
```

### 2) C1 receives committed_id=129 later

**Server -> C1**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-129
  client_id: C2
  partitions:
    - P1
  committed_id: 129
  event:
    type: treeUpdate
    payload:
      target: explorer
  status_updated_at: 1738451399000
```

**C1 inserts row**
```
id=evt-uuid-129
committed_id=129
status=committed
```

### 3) C1 computes committed state
- Query ORDER BY committed_id, so 129 then 130.

## Assertions
- Both events are present in local DB.
- Committed view uses 129 before 130 regardless of arrival order.
