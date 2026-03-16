# Scenario 03 - Duplicate Submit Retry

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Ensure retry with same `id`, same `schemaVersion`, and same payload is idempotent.

## Actors
- C1
- Server

## Preconditions
- Server already has committed event:
  - `id=evt-uuid-1`
  - `schemaVersion=1`
  - `committedId=101`

## Steps

### 1) C1 resubmits same event

**C1 -> Server**
```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [P1]
      projectId: P1
      userId: U1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: A, parentId: _root, index: 0 }
      meta:
        clientId: C1
        clientTs: 1738451204000
```

### 2) Server dedupes by `id`

**Server -> C1**
```yaml
type: submit_events_result
protocolVersion: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committedId: 101
      created: 1738451205000
```

## Assertions
- No new commit is created.
- `committedId` sequence does not advance for this retry.
