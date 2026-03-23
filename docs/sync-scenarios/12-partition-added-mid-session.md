# Scenario 12 - Add Partition Mid-Session Removed

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

## Goal
Document the v2 change from mutable partition scope to project-scoped clients.

## Actors
- C1
- Server

## Preconditions
- C1 is already running against project `P1`.
- The application now needs data from a different project or partition set.

## Steps

### 1) Scope expansion is no longer a `sync` operation

- In v2, `createSyncClient(...)` is bound to one `projectId`.
- The protocol no longer supports changing sync scope by sending a new partition list.
- If the app needs another project, it should start a separate client/store for that project.

### 2) Migration pattern
- Keep one client/store instance for `P1`.
- Start another client/store instance for the new project scope.
- Let each instance maintain its own durable cursor and draft queue.

## Assertions
- Mid-session partition-union sync is not part of the v2 protocol.
- Project changes require a separate client/store lifecycle.
- This keeps durable cursors and pending drafts scoped to one project.
