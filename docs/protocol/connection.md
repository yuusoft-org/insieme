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
- If protocol version is unsupported, server **MUST** send `protocolVersion_unsupported` and close.

## Handshake

### Client -> Server: `connect`

```yaml
type: connect
protocolVersion: "1.0"
payload:
  token: jwt
  clientId: client-123
  projectId: workspace-1
```

### Server -> Client: `connected`

```yaml
type: connected
protocolVersion: "1.0"
payload:
  clientId: client-123
  projectId: workspace-1
  projectLastCommittedId: 1700
```

Field semantics:

- `projectId` is the authenticated project scope for this connection.
- `projectLastCommittedId` is the project high-watermark at handshake time.
- Client uses this value to decide whether sync is needed.

## Auth Rules

- Server validates JWT signature and expiry.
- The authenticated `clientId` **MUST** match `connect.payload.clientId`.
- Server **MUST** authorize `connect.payload.projectId` before activating the session.
- Authenticated connection identity is authoritative for all later requests.
- Later `submit_events` and `sync` requests **MUST** use the same `projectId` as the authenticated session.
- If token expires during a connection, server **MUST** send `auth_failed` and close.
- Implementations that can validate session state per message **SHOULD** do so before handling active requests.

## Active Requests

In `active` state, supported requests are:

- `submit_events`
- `sync`

Invalid shape -> `bad_request` (keep open).
Unauthorized or mismatched project scope -> `forbidden` (keep open).
Server inbound safety limit breach -> `rate_limited` (close).

## Reconnect

- On reconnect, client **MUST** run `connect` then `sync`.
- Connection-local runtime state is not durable and is reconstructed after reconnect.
- For local-only/offline deployment, an offline transport can satisfy the same `connect` -> `sync` sequence without network.

## Transport Keepalive

Protocol does not require explicit `heartbeat`/`disconnect` messages in core mode.
Use transport-level keepalive (for example WebSocket ping/pong) and normal socket close.
