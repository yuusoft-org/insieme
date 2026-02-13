# Scenario 12 - Add Partition Mid-Session

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify partition-scope expansion with the simplified sync scope model.

## Actors
- C1
- Server

## Preconditions
- C1 current active scope is `[P1]` and durable cursor is `800`.
- Server contains older history in `P2` at `committed_id=50,120,350`.

## Steps

### 1) C1 expands scope to `[P1, P2]`

In core mode, `sync.partitions` defines both catch-up scope and future broadcast scope.
To include full history for newly added `P2`, C1 performs a union full catch-up:

**C1 -> Server**
```yaml
type: sync
protocol_version: "1.0"
payload:
  partitions: [P1, P2]
  since_committed_id: 0
  limit: 500
```

### 2) Server returns union history
- Includes historical events for P1 and P2 up to current watermark.

### 3) C1 applies idempotently
- Existing P1 committed rows are deduped by `id`/`committed_id`.
- Missing P2 history is added.

## Assertions
- C1 converges with complete history for both P1 and P2.
- Active broadcast scope after sync is `[P1, P2]`.
- No duplicate committed rows are created.
