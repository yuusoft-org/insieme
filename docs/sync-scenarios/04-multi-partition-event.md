# Scenario 04 - Multi-Partition Event

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify one committed event is visible in each referenced partition.

## Actors
- C1 (origin)
- C2 (scope includes `P1`)
- C3 (scope includes `P2`)
- Server

## Preconditions
- C1, C2, C3 connected.
- C1 can submit to both `P1` and `P2`.

## Steps

### 1) C1 submits event with two partitions

**C1 -> Server**
```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-mp1
      partitions: [P1, P2]
      event:
        type: event
        payload:
          schema: explorer.folderCreated
          data: { id: X, parent: _root, position: first }
```

### 2) Server commits and delivers
- Commit as one event with one `committed_id`.
- Return `submit_events_result` to C1.
- Broadcast to C2 and C3 (scope intersection).

## Assertions
- C2 receives committed event in `P1` view.
- C3 receives committed event in `P2` view.
- Event identity (`id`, `committed_id`) is identical across both partition views.
