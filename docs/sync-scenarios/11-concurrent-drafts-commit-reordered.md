# Scenario 11 - Multiple Local Drafts, Commit Order Reordered

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify client rebase correctness when server commit order differs from local submit order.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- C1 is connected and subscribed to ["P1"].
- Server global committed_id = 500.
- C1 has three local drafts for P1:
  - D1: `id=evt-d1`, `draft_clock=1`
  - D2: `id=evt-d2`, `draft_clock=2`
  - D3: `id=evt-d3`, `draft_clock=3`

## Steps

### 1) C1 submits D1, D2, D3 in draft_clock order

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-d1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d1
      options:
        parent: _root
        position: first
```

```yaml
type: submit_event
payload:
  id: evt-d2
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d2
      options:
        parent: _root
        position: first
```

```yaml
type: submit_event
payload:
  id: evt-d3
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d3
      options:
        parent: _root
        position: first
```

### 2) Server commits in different order

Due to concurrent validation or internal scheduling, server commits:
- D2 -> committed_id=501
- D1 -> committed_id=502
- D3 -> committed_id=503

### 3) C1 receives event_committed for D2

**Server -> C1**
```yaml
type: event_committed
payload:
  id: evt-d2
  client_id: C1
  partitions:
    - P1
  committed_id: 501
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d2
      options:
        parent: _root
        position: first
  status_updated_at: 1738451300000
```

**C1 local state after D2 committed**
- Update row: `id=evt-d2`, `status=committed`, `committed_id=501`
- committed(P1) = [501(D2)]
- drafts(P1) = [D1(clock=1), D3(clock=3)]

### 4) C1 receives event_committed for D1

**Server -> C1**
```yaml
type: event_committed
payload:
  id: evt-d1
  client_id: C1
  partitions:
    - P1
  committed_id: 502
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d1
      options:
        parent: _root
        position: first
  status_updated_at: 1738451300100
```

**C1 local state after D1 committed**
- Update row: `id=evt-d1`, `status=committed`, `committed_id=502`
- committed(P1) = [501(D2), 502(D1)]
- drafts(P1) = [D3(clock=3)]

### 5) C1 receives event_committed for D3

**Server -> C1**
```yaml
type: event_committed
payload:
  id: evt-d3
  client_id: C1
  partitions:
    - P1
  committed_id: 503
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-d3
      options:
        parent: _root
        position: first
  status_updated_at: 1738451300200
```

**C1 local state after D3 committed**
- Update row: `id=evt-d3`, `status=committed`, `committed_id=503`
- committed(P1) = [501(D2), 502(D1), 503(D3)]
- drafts(P1) = []

## Assertions
- Each local draft row is upgraded by `id` exactly once (UPDATE, not INSERT).
- Final committed order is 501(D2), 502(D1), 503(D3) — ordered by `committed_id`, not `draft_clock`.
- No duplicate rows exist for any of the three events.
- After each commit arrives, rebase recomputes local view state correctly with remaining drafts on top.
- When all drafts are committed, draft overlay is empty.
