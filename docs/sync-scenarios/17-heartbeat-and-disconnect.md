# Scenario 17 - Heartbeat and Graceful Disconnect

Note: All YAML messages include the standard envelope fields (`msg_id`, `timestamp`, `protocol_version`). They are omitted here only when not central to the scenario.

## Goal
Verify heartbeat keep-alive behavior, server timeout on missing heartbeat, and graceful disconnect with immediate subscription cleanup.

## Actors
- C1 (client_id = "C1")
- C2 (client_id = "C2")
- Server

## Preconditions
- C1 and C2 are connected and subscribed to ["P1"].
- Server heartbeat timeout is configured (e.g. 30 seconds).
- Server global committed_id = 400.

## Steps

### 1) Normal heartbeat exchange

**C1 -> Server**
```yaml
type: heartbeat
payload: {}
```

**Server -> C1**
```yaml
type: heartbeat_ack
payload: {}
```

C1 connection remains active. Server resets its timeout timer for C1.

### 2) C1 gracefully disconnects

**C1 -> Server**
```yaml
type: disconnect
payload:
  reason: client_shutdown
```

**Server behavior**
- Immediately removes C1 from the subscription set for P1.
- Closes the WebSocket connection for C1.
- No heartbeat timeout needed — cleanup is immediate.

### 3) New event is committed while C1 is disconnected

C2 submits an event that gets committed.

**C2 -> Server**
```yaml
type: submit_event
payload:
  id: evt-uuid-dc1
  partitions:
    - P1
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: dc-item
      options:
        parent: _root
        position: first
```

Server commits with committed_id=401.

**Server -> C2 (commit)**
```yaml
type: event_committed
payload:
  id: evt-uuid-dc1
  client_id: C2
  partitions:
    - P1
  committed_id: 401
  event:
    type: treePush
    payload:
      target: explorer
      value:
        id: dc-item
      options:
        parent: _root
        position: first
  status_updated_at: 1738452100000
```

Server does **not** broadcast to C1 (already disconnected and unsubscribed).

### 4) Heartbeat timeout (separate example)

If C2 stops sending heartbeats and the server's timeout window elapses:

**Server behavior**
- Server closes the WebSocket connection for C2.
- Removes C2 from all subscription sets.
- C2 must reconnect with `connect` and re-sync.

## Assertions
- `heartbeat_ack` is sent in response to each `heartbeat`.
- After `disconnect`, server immediately removes the client from all subscription sets.
- No broadcasts are sent to a disconnected client.
- If heartbeat is not received within the server's timeout window, the server closes the connection.
- After timeout or disconnect, reconnect requires a full `connect` + `sync` flow.
