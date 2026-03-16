# Scenario 09 - Same `id`, Different Payload

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Ensure server rejects same `id` when canonical payload differs.

## Actors
- C1
- Server

## Preconditions
- Server already committed:
  - `id=evt-uuid-4`
  - `schemaVersion=1`
  - payload A
  - `committedId=200`

## Steps

### 1) C1 submits same `id` with payload B

**C1 -> Server**
```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-4
      partitions: [P1]
      projectId: P1
      userId: U1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: DIFFERENT, parentId: _root, index: 0 }
      meta:
        clientId: C1
        clientTs: 1738451208800
```

### 2) Server rejects

**Server -> C1**
```yaml
type: submit_events_result
protocolVersion: "1.0"
payload:
  results:
    - id: evt-uuid-4
      status: rejected
      reason: validation_failed
      errors:
        - field: payload
          message: id already committed with different payload
      created: 1738451209000
```

## Assertions
- No new commit is created.
- Existing committed row for `evt-uuid-4` remains unchanged.
