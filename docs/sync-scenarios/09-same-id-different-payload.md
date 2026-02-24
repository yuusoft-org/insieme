# Scenario 09 - Same `id`, Different Payload

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Ensure server rejects same `id` when canonical payload differs.

## Actors
- C1
- Server

## Preconditions
- Server already committed:
  - `id=evt-uuid-4`
  - payload A
  - `committed_id=200`

## Steps

### 1) C1 submits same `id` with payload B

**C1 -> Server**
```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-4
      partitions: [P1]
      event:
        type: event
        payload:
          schema: explorer.folderCreated
          data: { id: DIFFERENT, parent: _root, position: first }
```

### 2) Server rejects

**Server -> C1**
```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-4
      status: rejected
      reason: validation_failed
      errors:
        - field: event
          message: id already committed with different payload
      status_updated_at: 1738451209000
```

## Assertions
- No new commit is created.
- Existing committed row for `evt-uuid-4` remains unchanged.
