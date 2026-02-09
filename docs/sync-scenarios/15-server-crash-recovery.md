# Scenario 15 - Server Crash Recovery

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify correct recovery when the server crashes after persisting a committed event but before sending `event_committed` to the origin client.

## Actors
- C1 (client_id = "C1", origin)
- C2 (client_id = "C2", peer)
- Server

## Preconditions
- C1 and C2 are connected and subscribed to ["P1"].
- Server global committed_id = 300.
- C1 has a local draft:
  - `id=evt-crash-1`, `status=draft`, `draft_clock=1`

## Steps

### 1) C1 submits event

**C1 -> Server**
```yaml
type: submit_event
payload:
  id: evt-crash-1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: crash-item
      options:
        parent: _root
        position: first
```

### 2) Server commits and persists

- Server validates and assigns committed_id=301.
- Server durably writes the committed event to storage.
- Server crashes **before** sending `event_committed` to C1 or `event_broadcast` to C2.

### 3) Server restarts

- Server rebuilds in-memory state from durable commit log.
- All connections are closed. Subscription state is lost.
- committed_id=301 exists in storage.

### 4) C1 reconnects

**C1 -> Server**
```yaml
type: connect
payload:
  token: jwt
  client_id: C1
  last_committed_id: 300
```

**Server -> C1**
```yaml
type: connected
payload:
  client_id: C1
  server_time: 1738452000000
  server_last_committed_id: 301
  capabilities:
    profile: compatibility
    accepted_event_types:
      - set
      - unset
      - treePush
      - treeDelete
      - treeUpdate
      - treeMove
    tree_policy: strict
```

### 5) C1 syncs to catch up

**C1 -> Server**
```yaml
type: sync
payload:
  partitions:
    - P1
  subscription_partitions:
    - P1
  since_committed_id: 300
  limit: 500
```

**Server -> C1**
```yaml
type: sync_response
payload:
  partitions:
    - P1
  effective_subscriptions:
    - P1
  events:
    - id: evt-crash-1
      client_id: C1
      partitions:
        - P1
      committed_id: 301
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: crash-item
          options:
            parent: _root
            position: first
      status_updated_at: 1738451900000
  next_since_committed_id: 301
  sync_to_committed_id: 301
  has_more: false
```

### 6) C1 applies sync and upgrades draft

C1 receives its own event via sync. The upsert strategy handles this:
- UPDATE by `id=evt-crash-1`: `status=committed`, `committed_id=301`, `status_updated_at=1738451900000`
- Draft overlay no longer includes evt-crash-1.

### 7) C1 also retries pending drafts (idempotent)

C1 may also retry `submit_event` for `evt-crash-1` as part of its reconnect flow. Server dedupes by `id` and returns the existing committed result. The client receives the same `event_committed` and the UPDATE is a no-op (row already committed).

### 8) C2 reconnects and syncs

C2 follows the same reconnect flow and receives committed_id=301 via sync_response.

## Assertions
- The committed event survives the server crash (durable persistence before response).
- C1 recovers the committed event via sync catch-up, even though it never received `event_committed`.
- C1's draft is correctly upgraded to committed via upsert (UPDATE by `id`).
- If C1 retries the submit, server dedupes by `id` — no duplicate commit is created.
- C2 receives the event on its next sync — no events are lost.
- All clients converge to the same committed state after reconnect.
