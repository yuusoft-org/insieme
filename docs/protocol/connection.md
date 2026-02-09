# Connection

This document defines the connection lifecycle: handshake, authentication, heartbeat, disconnect, and reconnect semantics.

## Connection State

- Messages other than `connect` and `heartbeat` sent before `connected` should be rejected with `bad_request`.
- The server must bind a connection to the authenticated identity from JWT.
- If the same `client_id` connects while an existing connection is active, the server should close the older connection. Only one connection per `client_id` is allowed.

## Handshake

### Client → Server: `connect`

```yaml
msg_id: msg-1
type: connect
timestamp: 1738451200000
protocol_version: "1.0"
payload:
  token: jwt
  client_id: client-123
  last_committed_id: 1200       # client's latest committed cursor
```

### Server → Client: `connected`

```yaml
msg_id: msg-2
type: connected
timestamp: 1738451200001
protocol_version: "1.0"
payload:
  client_id: client-123
  server_time: 1738451200000
  server_last_committed_id: 1700  # server's global high-watermark
  model_version: 3                # optional, present in model mode
```

Field semantics:
- `server_last_committed_id`: server's global high-watermark at handshake time. The client can use this to decide whether it needs to sync (if `server_last_committed_id > client's local cursor`, sync is needed).
- `model_version` (optional): current model/domain schema version. If the client's local snapshot has a different version, it must invalidate and re-sync.

## Auth Rules

- Server **validates JWT only** (signature + `exp`).
- Token is issued by an external auth service (not by this server).
- Required claim: `client_id` (must match `payload.client_id`).
- No partition scoping in JWT (access is global for now).
- On auth failure: send `error` with code `auth_failed` and close the connection.
- For all post-connect messages, the authenticated connection identity is authoritative. `payload.client_id` is untrusted input and may be omitted by clients. If present and mismatched, server must reject with `auth_failed`.
- For committed storage and outbound messages, server must write the authenticated `client_id`, not any caller-provided value.
- `connect` does not establish partition subscriptions; clients declare partitions in `sync` requests.
- If the JWT expires during a long-lived connection, the server should close the connection. Token refresh requires a new `connect`.

## Heartbeat & Timeouts

- Client must send `heartbeat` on a regular interval (implementation-defined).
- Server replies with `heartbeat_ack`.
- If no heartbeat is received within the server's timeout window, the server closes the connection.

## Disconnect

- A client that is intentionally closing should send `disconnect` first so the server can release subscription state immediately.

## Reconnect

- Reconnects must re-run `connect` and then `sync`.
- All subscriptions are removed on connection close; clients must re-establish them via `sync` with `subscription_partitions`.
