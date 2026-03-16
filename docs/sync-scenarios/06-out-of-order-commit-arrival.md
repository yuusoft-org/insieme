# Scenario 06 - Out-of-Order Commit Arrival

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Verify client convergence when committed deliveries arrive out of order.

## Actors
- C1
- Server

## Preconditions
- Server has:
  - `committedId=129` (`id=evt-uuid-129`)
  - `committedId=130` (`id=evt-uuid-130`)

## Steps

### 1) C1 receives 130 first

**Server -> C1**
```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 130
  id: evt-uuid-130
  partitions: [P1]
  type: explorer.folderCreated
  schemaVersion: 1
  payload: { id: B }
  meta: { clientId: C2, clientTs: 1738451206800 }
  created: 1738451207000
```

### 2) C1 receives 129 later

**Server -> C1**
```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 129
  id: evt-uuid-129
  partitions: [P1]
  type: explorer.folderCreated
  schemaVersion: 1
  payload: { id: A }
  meta: { clientId: C2, clientTs: 1738451206700 }
  created: 1738451206900
```

## Assertions
- Client stores both events idempotently.
- State computation uses `ORDER BY committed_id`, yielding `committedId` order `129` then `130`.
