# Scenario 16 - Batch Submit (Offline Catch-Up)

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify batch submission of multiple drafts accumulated offline, including mixed commit/reject results and peer broadcast behavior.

## Actors
- C1 (client_id = "C1", origin)
- C2 (client_id = "C2", peer)
- Server

## Preconditions
- C1 was offline and accumulated 3 drafts in `draft_clock` order.
- C1 has reconnected and completed sync catch-up.
- C2 is connected and subscribed to ["P1"].
- Server global committed_id = 600.

## Steps

### 1) C1 submits batch of offline drafts

**C1 -> Server**
```yaml
type: submit_events
payload:
  events:
    - id: evt-batch-1
      partitions:
        - P1
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: item-b1
          options:
            parent: _root
            position: first
    - id: evt-batch-2
      partitions:
        - P1
      event:
        type: treeUpdate
        payload:
          target: explorer
          value:
            name: Renamed
          options:
            id: item-b1
    - id: evt-batch-3
      partitions:
        - P1
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: item-b1
          options:
            parent: _root
            position: first
```

### 2) Server processes batch in list order

- evt-batch-1: valid, committed_id=601
- evt-batch-2: valid (validated against state after evt-batch-1), committed_id=602
- evt-batch-3: rejected — `item-b1` already exists (duplicate id in items, pushed by evt-batch-1)

**Server -> C1**
```yaml
type: submit_events_result
payload:
  results:
    - id: evt-batch-1
      status: committed
      committed_id: 601
      status_updated_at: 1738452000000
    - id: evt-batch-2
      status: committed
      committed_id: 602
      status_updated_at: 1738452000100
    - id: evt-batch-3
      status: rejected
      reason: validation_failed
      errors:
        - field: event.payload.value.id
          message: duplicate id in items
      status_updated_at: 1738452000200
```

### 3) Server broadcasts committed events to peers

Each committed item generates an individual `event_broadcast`.

**Server -> C2 (broadcast evt-batch-1)**
```yaml
type: event_broadcast
payload:
  id: evt-batch-1
  client_id: C1
  partitions:
    - P1
  committed_id: 601
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: item-b1
      options:
        parent: _root
        position: first
  status_updated_at: 1738452000000
```

**Server -> C2 (broadcast evt-batch-2)**
```yaml
type: event_broadcast
payload:
  id: evt-batch-2
  client_id: C1
  partitions:
    - P1
  committed_id: 602
  event:
    type: treeUpdate
    payload:
      target: explorer
      value:
        name: Renamed
      options:
        id: item-b1
  status_updated_at: 1738452000100
```

No broadcast for evt-batch-3 (rejected events are never broadcast).

### 4) C1 updates local DB

- evt-batch-1: UPDATE by `id`, `status=committed`, `committed_id=601`
- evt-batch-2: UPDATE by `id`, `status=committed`, `committed_id=602`
- evt-batch-3: UPDATE by `id`, `status=rejected`, `reject_reason="validation_failed"`

### 5) C1 recomputes local view state

- committed(P1) = [..., 601(evt-batch-1), 602(evt-batch-2)]
- drafts(P1) = [] (evt-batch-3 is rejected, excluded from view)

## Assertions
- Server processes batch items in list order (evt-batch-2 is validated against state after evt-batch-1).
- Mixed results are returned in a single `submit_events_result` response.
- Rejected events do not advance the committed_id sequence.
- Each committed item generates an individual `event_broadcast` to peers.
- Rejected items are not broadcast.
- C1 upgrades committed drafts and marks rejected drafts in a single pass.
- No duplicate rows exist.
