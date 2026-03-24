# Scenario 04 - Multi-Partition Event Removed

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Document the v2 change from multi-partition events to single-partition events.

## Actors
- C1 (origin)
- Server

## Preconditions
- C1 is connected to project `P1`.
- The application wants to affect both partition `P1` and partition `P2`.

## Steps

### 1) Legacy shape is no longer accepted

**C1 -> Server**
```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-mp1
      partition: P1
      projectId: P1
      userId: U1
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: X, parentId: _root, index: 0 }
      meta:
        clientId: C1
        clientTs: 1738451204000
```

### 2) Replication pattern in v2
- Each committed event carries exactly one `partition`.
- If the application needs the same logical change in multiple partitions, it must submit multiple events with distinct ids.
- Broadcast fan-out is project-scoped; consumers inspect each event's single `partition`.

## Assertions
- Multi-partition payloads are not part of the v2 protocol.
- One committed event maps to one partition.
- Apps that need cross-partition effects must model them above the core protocol.
