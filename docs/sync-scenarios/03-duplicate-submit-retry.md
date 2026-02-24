# Scenario 03 - Duplicate Submit Retry

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Ensure retry with same `id` and same payload is idempotent.

## Actors
- C1
- Server

## Preconditions
- Server already has committed event:
  - `id=evt-uuid-1`
  - `committed_id=101`

## Steps

### 1) C1 resubmits same event

**C1 -> Server**
```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [P1]
      event:
        type: event
        payload:
          schema: explorer.folderCreated
          data: { id: A, parent: _root, position: first }
```

### 2) Server dedupes by `id`

**Server -> C1**
```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committed_id: 101
      status_updated_at: 1738451205000
```

## Assertions
- No new commit is created.
- `committed_id` sequence does not advance for this retry.
