# Scenario 02 - Local Draft Rejected

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify rejected submit removes local draft and does not broadcast.

## Actors
- C1
- Server

## Preconditions
- C1 connected with partition scope including `P1`.
- `local_drafts` contains `id=evt-uuid-rj1`.

## Steps

### 1) C1 submits invalid draft

**C1 -> Server**
```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-rj1
      partitions: [P1]
      event:
        type: treePush
        payload:
          target: explorer
          value: { id: A }
          options: { parent: does-not-exist, position: first }
```

### 2) Server rejects

**Server -> C1**
```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-rj1
      status: rejected
      reason: validation_failed
      errors:
        - field: event.payload.options.parent
          message: parent not found
      status_updated_at: 1738451205100
```

## Assertions
- C1 removes `evt-uuid-rj1` from `local_drafts`.
- No row is inserted into `committed_events` for `evt-uuid-rj1`.
- No `event_broadcast` is emitted.
