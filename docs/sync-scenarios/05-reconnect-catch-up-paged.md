# Scenario 05 - Reconnect Catch-Up (Paged)

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify paged sync catch-up and simplified broadcast behavior during active sync.

## Actors
- C1
- Server

## Preconditions
- C1 durable cursor is `120`.
- Server has committed events `121..125` for `P1`.
- Sync page size is `2`.

## Steps

### 1) Reconnect + first page

**C1 -> Server**
```yaml
type: sync
protocol_version: "1.0"
payload:
  partitions: [P1]
  since_committed_id: 120
  limit: 2
```

**Server -> C1**
```yaml
type: sync_response
protocol_version: "1.0"
payload:
  partitions: [P1]
  events: [121, 122]
  next_since_committed_id: 122
  has_more: true
```

### 2) More pages
- Second page returns `[123, 124]`, `next_since_committed_id:124`, `has_more:true`.
- Third page returns `[125]`, `next_since_committed_id:125`, `has_more:false`.

### 3) Broadcast suppression during active sync
- While `has_more=true`, server does not send `event_broadcast` to C1.
- After final page (`has_more=false`), normal broadcasts resume.

## Assertions
- C1 applies all committed events in `committed_id` order.
- Durable cursor is updated to `125` only after final page is persisted.
- No client-side broadcast buffering is required.
