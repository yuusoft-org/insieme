# Scenario 04 - Multi-Partition Event

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify events that belong to multiple partitions are visible in all corresponding partition views and delivered to all intersecting subscribers.

## Actors
- C1 subscribed to ["P1"]
- C2 subscribed to ["P2"]
- C3 subscribed to ["P1", "P2"]
- Server

## Preconditions
- Server global committed_id = 101.
- All clients connected.
- C1 is subscribed only to P1 for broadcast, but submissions are allowed for partitions outside the current subscription set.

## Steps

### 1) C1 submits event for P1 + P2

**C1 -> Server**
```yaml
type: submit_events
payload:
  events:
    - id: evt-uuid-3
      client_id: C1
      partitions:
        - P1
        - P2
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: B
          options:
            parent: _root
            position: first
```

### 2) Server commits
- Assign committed_id=102.
- Persist event with partitions ["P1","P2"].

### 3) Broadcast
- C1 receives submit_events_result.
- C2 and C3 receive event_broadcast (subscriptions intersect).

## Expected Local DB Inserts
- All clients store a committed row with:
  - id=evt-uuid-3
  - committed_id=102
  - partitions=["P1","P2"]
  - client_id=C1

## Expected View States

**P1 view** (clients C1, C3): includes evt-uuid-3.

**P2 view** (clients C2, C3): includes evt-uuid-3.

## Assertions
- Broadcast is delivered to all clients whose subscription intersects the event partitions.
- Per-partition views include events whose partitions contain that partition.
- C2 (subscribed only to P2) does not see the event in any P1 view.
- C1 receives origin confirmation via `submit_events_result` only.
- Server does not send `event_broadcast` for this item back to the origin connection.
