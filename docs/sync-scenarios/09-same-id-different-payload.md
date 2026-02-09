# Scenario 09 - Same id, Different Payload

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Ensure the server rejects a re-submit of the same id with different payload.

## Actors
- C1
- Server

## Preconditions
- Event already committed:
  - id = "evt-uuid-4"
  - committed_id = 200
  - payload = A

## Steps

### 1) C1 submits same id with different payload

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-uuid-4
  client_id: C1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: DIFFERENT
      options:
        parent: _root
        position: first
```

### 2) Server detects mismatch
- Lookup by id returns existing payload A.
- New payload differs.

**Server -> C1**
```yaml
type: event_rejected
payload:
  id: evt-uuid-4
  client_id: C1
  partitions:
    - P1
  reason: validation_failed
  errors:
    - field: event
      message: id already committed with different payload
  status_updated_at: 1738451500000
```

## Expected Results
- No new committed event.
- Client keeps the original committed row.
- Draft with same id (if any) should be rejected.

## Assertions
- committed_id sequence does not advance.
- Server always rejects conflicting payloads for the same id.
