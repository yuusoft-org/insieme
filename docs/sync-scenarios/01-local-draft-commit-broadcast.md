# Scenario 01 - Local Draft -> Commit + Broadcast

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify a local draft is stored first, then committed by the server and broadcast to other clients.

## Actors
- C1 (origin client_id = "C1")
- C2 (peer client_id = "C2")
- Server

## Preconditions
- Both C1 and C2 are connected and subscribed to ["P1"].
- Server global last committed_id = 100.
- Both clients have empty local DBs for P1.
- C1 draft_clock = 0.

## Steps

### 1) C1 creates a local draft
- id = "evt-uuid-1"
- draft_clock = 1
- partitions = ["P1"]

**Local DB insert (C1)**
```
id=evt-uuid-1
committed_id=NULL
status=draft
partitions=["P1"]
client_id=C1
draft_clock=1
created_at=<local time>
```

**Local view state (C1, P1)**
- committed(P1) = []
- drafts(P1) = [evt-uuid-1]

### 2) C1 submits to server

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-uuid-1
  client_id: C1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: A
      options:
        parent: _root
        position: first
```

### 3) Server validates and commits
- Validates event.
- Assigns committed_id = 101 (global, monotonic).
- Persists committed event (append-only).

### 4) Server responds + broadcasts

**Server -> C1 (commit)**
```yaml
type: event_committed
payload:
  id: evt-uuid-1
  client_id: C1
  partitions:
    - P1
  committed_id: 101
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: A
      options:
        parent: _root
        position: first
  status_updated_at: 1738451205000
```

**Server -> C2 (broadcast)**
```yaml
type: event_broadcast
payload:
  id: evt-uuid-1
  client_id: C1
  partitions:
    - P1
  committed_id: 101
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: A
      options:
        parent: _root
        position: first
  status_updated_at: 1738451205000
```

### 5) Client DB updates

**C1: upgrade draft -> committed**
```
id=evt-uuid-1
committed_id=101
status=committed
status_updated_at=1738451205000
```

**C2: insert committed row**
```
id=evt-uuid-1
committed_id=101
status=committed
partitions=["P1"]
client_id=C1
```

## Expected Local View State

**C1 (P1)**
- committed(P1) = [evt-uuid-1]
- drafts(P1) = []

**C2 (P1)**
- committed(P1) = [evt-uuid-1]
- drafts(P1) = []

## Assertions
- Server emits exactly one commit with committed_id=101.
- C1 upgrades existing draft, does not create a second row.
- C2 inserts one committed row.
- No duplicate committed rows exist (unique committed_id).
