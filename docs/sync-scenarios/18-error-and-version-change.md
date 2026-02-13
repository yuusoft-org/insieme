# Scenario 18 - Error Handling and Model Version Upgrade

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify server error responses for auth failure, bad request, and unsupported protocol version. Also verify deployment-driven model version upgrade handling and client re-sync behavior.

## Actors
- C1 (client_id = "C1")
- Server

## Part A: Auth Failure

### 1) C1 connects with expired JWT

**C1 -> Server**
```yaml
type: connect
payload:
  token: expired-jwt
  client_id: C1
  last_committed_id: 0
```

**Server -> C1**
```yaml
type: error
payload:
  code: auth_failed
  message: Token expired
```

Server closes the connection after sending this error.

## Part B: Bad Request

### 1) C1 sends a message before completing handshake

C1 sends `submit_events` without first completing `connect`/`connected`.

**C1 -> Server**
```yaml
type: submit_events
payload:
  events:
    - id: evt-uuid-bad
      partitions:
        - P1
      event:
        type: treePush
        payload:
          target: explorer
          value:
            id: bad-item
          options:
            parent: _root
            position: first
```

**Server -> C1**
```yaml
type: error
payload:
  code: bad_request
  message: Must complete handshake before sending submit_events
```

Connection remains open (bad_request does not close the connection). C1 should send `connect` first.

### 2) C1 sends unknown message type

**C1 -> Server**
```yaml
type: unknown_type
payload: {}
```

**Server -> C1**
```yaml
type: error
payload:
  code: bad_request
  message: Unknown message type
```

Connection remains open.

## Part C: Protocol Version Unsupported

### 1) C1 connects with unsupported protocol version

**C1 -> Server**
```yaml
type: connect
timestamp: 1738451200000
protocol_version: "99.0"
payload:
  token: jwt
  client_id: C1
  last_committed_id: 0
```

**Server -> C1**
```yaml
type: error
payload:
  code: protocol_version_unsupported
  message: Unsupported protocol version
  details:
    requested_version: "99.0"
    supported_versions:
      - "1.0"
```

Server closes the connection after sending this error.

## Part D: Model Version Upgrade (No Dynamic Broadcast)

### Preconditions
- C1 is connected, subscribed to ["P1"], using the canonical `event` profile.
- Current model_version = 3.
- C1 has a local snapshot for P1 at model_version = 3.

### 1) Server deploys new model version

The server's model/domain schema is updated from version 3 to version 4.
No `version_changed` push message is sent in protocol `1.0`.

### 2) C1 reconnects/syncs and detects mismatch

C1 updates client code/runtime to version 4 and reconnects.
C1 observes `model_version=4` from handshake/sync metadata and compares it to local snapshot version `3`.

- C1 invalidates all local model snapshots.
- C1 performs a full re-sync from `since_committed_id=0` for all active model partitions.

**Server -> C1**
```yaml
type: connected
payload:
  client_id: C1
  server_time: 1738452200000
  server_last_committed_id: 900
  capabilities:
    profile: canonical
    accepted_event_types:
      - event
  model_version: 4
```

**C1 -> Server**
```yaml
type: sync
payload:
  partitions:
    - P1
  since_committed_id: 0
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
    - id: evt-uuid-m1
      client_id: C5
      partitions:
        - P1
      committed_id: 1
      event:
        type: event
        payload:
          schema: branch.create
          data:
            name: Main
      status_updated_at: 1738440000000
  next_since_committed_id: 1
  sync_to_committed_id: 1
  has_more: false
```

### 3) C1 rebuilds state

- Replay all committed events with the new model version's reducers.
- Create a new snapshot with `model_version=4`.
- Re-apply any pending drafts on top.

## Assertions

**Auth failure:**
- Server sends `error` with `code: auth_failed` and closes the connection.
- No `connected` response is sent.

**Bad request:**
- Server sends `error` with `code: bad_request` and keeps the connection open.
- Client can recover by sending the correct message.

**Protocol version unsupported:**
- Server sends `error` with `code: protocol_version_unsupported`, includes `details.supported_versions`, and closes the connection.

**Model version upgrade:**
- Server does not send a dynamic `version_changed` push message.
- Client detects mismatch from `model_version` in `connected` / `sync_response`.
- Client invalidates all local model snapshots.
- Client performs full re-sync (`since_committed_id=0`) for all active model partitions.
- New snapshot is stored with the updated `model_version`.
