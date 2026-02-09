# Scenario 14 - LWW Conflict: Concurrent Update

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify that concurrent updates to the same item from different clients converge to the same state via server-ordered Last-Write-Wins (LWW).

## Actors
- C1 (client_id = "C1")
- C2 (client_id = "C2")
- Server

## Preconditions
- Both C1 and C2 are connected and subscribed to ["P1"].
- Server global committed_id = 200.
- Both clients have a committed item in their P1 tree state:
  ```yaml
  explorer:
    items:
      item1:
        id: item1
        name: Original
        type: file
    tree:
      - id: item1
        children: []
  ```

## Steps

### 1) C1 and C2 concurrently create drafts to update item1

**C1 local draft**
- id = "evt-c1-upd"
- draft_clock = 1
- event: `treeUpdate` with `name: "C1 Edit"`

**C2 local draft**
- id = "evt-c2-upd"
- draft_clock = 1
- event: `treeUpdate` with `name: "C2 Edit"`

Both clients apply their draft optimistically. At this point:
- C1 local view: `item1.name = "C1 Edit"`
- C2 local view: `item1.name = "C2 Edit"`

### 2) Both clients submit

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-c1-upd
  partitions:
    - P1
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C1 Edit
      options:
        id: item1
```

**C2 -> Server**
```yaml
type: submit_event
payload:
  id: evt-c2-upd
  partitions:
    - P1
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C2 Edit
      options:
        id: item1
```

### 3) Server commits in arrival order

Server receives C2 first, then C1:
- C2's event -> committed_id=201
- C1's event -> committed_id=202

### 4) Server sends responses and broadcasts

**Server -> C2 (commit)**
```yaml
type: event_committed
payload:
  id: evt-c2-upd
  client_id: C2
  partitions:
    - P1
  committed_id: 201
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C2 Edit
      options:
        id: item1
  status_updated_at: 1738451600000
```

**Server -> C1 (broadcast of C2's event)**
```yaml
type: event_broadcast
payload:
  id: evt-c2-upd
  client_id: C2
  partitions:
    - P1
  committed_id: 201
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C2 Edit
      options:
        id: item1
  status_updated_at: 1738451600000
```

**Server -> C1 (commit)**
```yaml
type: event_committed
payload:
  id: evt-c1-upd
  client_id: C1
  partitions:
    - P1
  committed_id: 202
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C1 Edit
      options:
        id: item1
  status_updated_at: 1738451600100
```

**Server -> C2 (broadcast of C1's event)**
```yaml
type: event_broadcast
payload:
  id: evt-c1-upd
  client_id: C1
  partitions:
    - P1
  committed_id: 202
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: C1 Edit
      options:
        id: item1
  status_updated_at: 1738451600100
```

### 5) Both clients rebase

After both events are committed, both clients compute committed state in `committed_id` order:

1. committed_id=201: `treeUpdate` -> `item1.name = "C2 Edit"`
2. committed_id=202: `treeUpdate` -> `item1.name = "C1 Edit"`

Final committed state on both clients:
```yaml
explorer:
  items:
    item1:
      id: item1
      name: C1 Edit
      type: file
  tree:
    - id: item1
      children: []
```

## Assertions
- Both clients converge to the same final state: `item1.name = "C1 Edit"`.
- The last write (highest `committed_id`) wins — C1's edit at committed_id=202 overwrites C2's at 201.
- C2's optimistic draft is temporarily visible locally, but after rebase the committed order prevails.
- No conflict resolution beyond ordering is needed — `treeUpdate` with `replace: false` (default) merges properties, and the later committed_id's values overwrite earlier ones.
