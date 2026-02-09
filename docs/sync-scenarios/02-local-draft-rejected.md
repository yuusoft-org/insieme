# Scenario 02 - Local Draft Rejected

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Ensure a draft is marked rejected and removed from the local view when the server rejects it.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- C1 is connected and subscribed to ["P1"].
- C1 has no committed events.
- C1 draft_clock = 1 (next draft will be 2).

## Steps

### 1) C1 creates a local draft
- id = "evt-uuid-2"
- draft_clock = 2
- partitions = ["P1"]

**Local DB insert (C1)**
```
id=evt-uuid-2
committed_id=NULL
status=draft
partitions=["P1"]
client_id=C1
draft_clock=2
created_at=<local time>
```

**Local view state (C1, P1)**
- committed(P1) = []
- drafts(P1) = [evt-uuid-2]

### 2) C1 submits to server

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-uuid-2
  client_id: C1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: A
```

### 3) Server rejects
- Validation fails (example: duplicate id).

**Server -> C1**
```yaml
type: event_rejected
payload:
  id: evt-uuid-2
  client_id: C1
  partitions:
    - P1
  reason: validation_failed
  errors:
    - field: payload.value.id
      message: duplicate id
  status_updated_at: 1738451210000
```

### 4) C1 updates local DB

```
id=evt-uuid-2
status=rejected
status_updated_at=1738451210000
reject_reason="validation_failed"
```

## Expected Local View State (C1, P1)
- committed(P1) = []
- drafts(P1) = []

## Assertions
- No committed event is created on the server.
- Rejected draft does not appear in local view state.
- A reject reason is stored locally for UI/audit.
