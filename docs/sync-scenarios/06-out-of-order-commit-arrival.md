# Scenario 06 - Out-of-Order Commit Arrival

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify client convergence when committed deliveries arrive out of order.

## Actors
- C1
- Server

## Preconditions
- Server has:
  - `committed_id=129` (`id=evt-uuid-129`)
  - `committed_id=130` (`id=evt-uuid-130`)

## Steps

### 1) C1 receives 130 first

**Server -> C1**
```yaml
type: event_broadcast
protocol_version: "1.0"
payload:
  id: evt-uuid-130
  committed_id: 130
  partitions: [P1]
  event: { type: treePush, payload: { target: explorer, value: { id: B } } }
  status_updated_at: 1738451207000
```

### 2) C1 receives 129 later

**Server -> C1**
```yaml
type: event_broadcast
protocol_version: "1.0"
payload:
  id: evt-uuid-129
  committed_id: 129
  partitions: [P1]
  event: { type: treePush, payload: { target: explorer, value: { id: A } } }
  status_updated_at: 1738451206900
```

## Assertions
- Client stores both events idempotently.
- State computation uses `ORDER BY committed_id`, yielding 129 then 130.
