# Connection

This document defines the minimal connection lifecycle: handshake, authentication, active requests, and reconnect behavior.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Connection State

Two protocol states:

- `await_connect`
- `active`

Rules:

- In `await_connect`, only `connect` is valid.
- Any non-`connect` message before handshake **MUST** be rejected with `bad_request`.
- On valid `connect`, server **MUST** send `connected` and move to `active`.
- If auth fails, server **MUST** send `auth_failed` and close.
- If protocol version is unsupported, server **MUST** send `protocol_version_unsupported` and close.

## Handshake

### Client -> Server: `connect`

```yaml
type: connect
protocol_version: "1.0"
payload:
  token: jwt
  client_id: client-123
```

### Server -> Client: `connected`

```yaml
type: connected
protocol_version: "1.0"
payload:
  client_id: client-123
  server_last_committed_id: 1700
```

Field semantics:

- `server_last_committed_id` is the server high-watermark at handshake time.
- Client uses this value to decide whether sync is needed.

## Auth Rules

- Server validates JWT signature and expiry.
- Required claim: `client_id`; it **MUST** match `connect.payload.client_id`.
- Authenticated connection identity is authoritative for all later requests.
- Partition authorization **MUST** be checked for both submit and sync.
- If token expires during a connection, server **MUST** send `auth_failed` and close.

## Active Requests

In `active` state, supported requests are:

- `submit_events`
- `sync`

Invalid shape -> `bad_request` (keep open).
Unauthorized partition scope -> `forbidden` (keep open).

## Reconnect

- On reconnect, client **MUST** run `connect` then `sync`.
- Connection-local runtime state is not durable and is reconstructed after reconnect.

## Transport Keepalive

Protocol does not require explicit `heartbeat`/`disconnect` messages in core mode.
Use transport-level keepalive (for example WebSocket ping/pong) and normal socket close.
