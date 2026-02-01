# Scenario 03 - Duplicate Submit (Retry)

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Ensure retries with the same `id` are idempotent and do not create new commits.

## Actors
- C1 (client_id = "C1")
- Server

## Preconditions
- An event with id="evt-uuid-1" is already committed.
- Server global committed_id=101 for that event.
- C1 local DB already has the committed row.

**Local DB (C1)**
```
id=evt-uuid-1
committed_id=101
status=committed
partitions=["P1"]
client_id=C1
```

## Steps

### 1) C1 retries submit_event (same id)

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
```

### 2) Server dedupes
- Lookup by `id`.
- Finds committed_id=101.
- Does not create a new commit.

**Server -> C1** (replay commit result)
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
  status_updated_at: 1738451205000
```

## Expected Results
- No new committed row in server storage.
- C1 local DB remains unchanged.
- No duplicate broadcast is required (optional if sent, must be idempotent).

## Assertions
- Global committed_id sequence does not advance.
- Only one committed row exists for id="evt-uuid-1".
