# Server Sync Protocol (Authoritative, WebSocket)

This document defines the **server-side sync behavior** for Insieme’s
authoritative event model. It focuses on WebSocket transport.

## Scope

- **JWT auth** (validation only). Token is issued externally.
- Server validates every event and decides to **commit** or **reject**.
- Server replies to the **origin client** and **broadcasts** committed events
  to all other connected clients whose subscriptions intersect the event’s
  partitions.

## High-Level Responsibilities

1. **Connection management** (track clients + partition subscriptions).
2. **Validation + commit decision** for every submitted event.
3. **Sequential ordering** with global `committed_id`.
4. **Durable persistence** before responding “committed”.
5. **Broadcast** committed events to other clients.
6. **Catch-up** for new connections (send missed committed events).

## Terms

- **id**: globally unique UUID from the client (draft id).
- **committed_id**: server-assigned global incremental id.
- **partitions**: array of logical streams the event belongs to.

## Message Envelope

All WebSocket messages (both directions) must include the following top-level fields:

- `type` (string): message type.
- `msg_id` (string): unique message id for tracing/debug.
- `timestamp` (number): sender time in ms (server uses authoritative time).
- `payload` (object): message-specific payload.
- `protocol_version` (string): version identifier (e.g., `"1.0"`).

Unknown fields should be ignored to allow forward compatibility.

Protocol requirements:
- Messages missing required envelope fields must be rejected with `bad_request`.
- If `protocol_version` is unsupported, respond with `error` and close.
- Unknown message `type` should be rejected with `bad_request`.

## Connection State

- Messages other than `connect` and `heartbeat` sent before `connected`
  should be rejected with `bad_request`.
- The server must bind a connection to the authenticated identity from JWT.

## Handshake & Auth

### Client → Server: connect
```yaml
msg_id: msg-1
type: connect
timestamp: 1738451200000
protocol_version: "1.0"
payload:
  token: jwt
  client_id: client-123
  last_committed_id: 1200
```

### Server → Client: connected
```yaml
msg_id: msg-2
type: connected
timestamp: 1738451200001
protocol_version: "1.0"
payload:
  client_id: client-123
  server_time: 1738451200000
  last_committed_id: 1200
```

### Auth Rules

- Server **validates JWT only** (signature + `exp`).
- Token is issued by an external auth service (not by this server).
- Required claim: `client_id` (must match `payload.client_id`).
- No partition scoping in JWT (access is global for now).
- On auth failure: send `error` and close the connection.
- For all subsequent messages, the server should trust the connection’s
  authenticated `client_id` and reject mismatches in payload.
- `connect` does not establish partition subscriptions; clients declare
  `partitions` in `sync` requests.

## Heartbeat & Timeouts

- Client must send `heartbeat` on a regular interval (implementation-defined).
- Server replies with `heartbeat_ack`.
- If no heartbeat is received within the server’s timeout window, the server
  closes the connection.
- Reconnects must re-run `connect` and then `sync`.

## Message Types (WebSocket)

These are illustrative shapes; exact fields can evolve.

### Client → Server

**submit_event**
```yaml
msg_id: msg-3
type: submit_event
timestamp: 1738451201000
protocol_version: "1.0"
payload:
  id: uuid
  client_id: client-123
  partitions:
    - workspace-1
    - workspace-2
  event:
    type: treePush
    payload: {} # ...
```

**sync**
```yaml
msg_id: msg-4
type: sync
timestamp: 1738451202000
protocol_version: "1.0"
payload:
  partitions:
    - workspace-1
    - workspace-2
  since_committed_id: 1200
  limit: 500
```

### Server → Client

**event_committed** (to origin client)
```yaml
msg_id: msg-5
type: event_committed
timestamp: 1738451205000
protocol_version: "1.0"
payload:
  id: uuid
  client_id: client-123
  partitions:
    - workspace-1
    - workspace-2
  committed_id: 1201
  event:
    type: treePush
    payload: {} # ...
  status_updated_at: 1738451200000
```

**event_rejected** (to origin client)
```yaml
msg_id: msg-6
type: event_rejected
timestamp: 1738451205000
protocol_version: "1.0"
payload:
  id: uuid
  client_id: client-123
  partitions:
    - workspace-1
    - workspace-2
  reason: validation_failed
  errors:
    - field: payload.value.id
      message: duplicate id
  status_updated_at: 1738451200000
```

**event_broadcast** (to other clients)
```yaml
msg_id: msg-7
type: event_broadcast
timestamp: 1738451205000
protocol_version: "1.0"
payload:
  id: uuid
  client_id: client-123
  partitions:
    - workspace-1
    - workspace-2
  committed_id: 1201
  event:
    type: treePush
    payload: {} # ...
  status_updated_at: 1738451200000
```

**sync_response**
```yaml
msg_id: msg-8
type: sync_response
timestamp: 1738451206000
protocol_version: "1.0"
payload:
  partitions:
    - workspace-1
    - workspace-2
  events: [] # committed events in order
  next_since_committed_id: 1700
  sync_to_committed_id: 1700
  has_more: false
```

**heartbeat**
```yaml
msg_id: msg-9
type: heartbeat
timestamp: 1738451207000
protocol_version: "1.0"
payload:
  client_id: client-123
```

**heartbeat_ack**
```yaml
msg_id: msg-10
type: heartbeat_ack
timestamp: 1738451207001
protocol_version: "1.0"
payload:
  client_id: client-123
```

**error**
```yaml
msg_id: msg-err-1
type: error
timestamp: 1738451207002
protocol_version: "1.0"
payload:
  code: auth_failed
  message: Invalid token
  details: {}
```

## Server Flow

### 1) Submit Event

1. Receive `submit_event`.
2. Validate payload (tree or model mode).
3. If invalid → send `event_rejected` to origin client.
   - No broadcast occurs on rejection.
4. If valid → assign `committed_id` (global, monotonic).
5. Persist the committed event (durable write).
6. Send `event_committed` to origin client.
7. Broadcast `event_broadcast` to all other clients whose subscriptions
   intersect the event’s partitions.

### 2) Sync / Catch-Up

When a client connects (or reconnects), it must supply the last
`committed_id` it has. The server returns all committed events **after** that id
whose partitions intersect the client’s requested partitions.

- If there are many events, respond in **pages** with `limit` + `has_more`.
- Clients can loop until `has_more=false`.
- The server should include a stable high-watermark in the first response
  (e.g., `sync_to_committed_id`) and keep it constant for that sync cycle to
  avoid missing concurrent commits during pagination.

## Validation

- The server is authoritative: it **must** validate every event.
- For **model/domain mode**, the server should validate the event envelope and
  schema (same rules as the client).
- For **tree mode**, validate the action payloads.

## Partition Semantics

- `partitions` must be a **non-empty array** of strings.
- The server treats `partitions` as a **set**:
  - Deduplicate and sort before storage.
  - Use the normalized array for hashing/equality checks.

## Error Codes (Canonical)

- `auth_failed` — invalid JWT or expired token.
- `bad_request` — malformed message or missing fields.
- `validation_failed` — schema or model validation failure.
- `rate_limited` — client exceeded allowed rate.
- `server_error` — unexpected internal error.

## Ordering & Idempotency

- `committed_id` is **monotonic globally**, never reused.
- `since_committed_id` in sync is **exclusive** (return events with committed_id > since).
- The server must dedupe by `id` (global UUID). If the same `id` is submitted
  again, return the existing committed result instead of re‑committing.
- If the same `id` is submitted with a **different payload**, reject with
  `validation_failed` and a descriptive error message.
- Broadcasts include both `id` and `committed_id` to support client idempotency.

Payload equality:
- The server should compare payloads by a **stable canonical form** (e.g., sorted
  JSON or a hash over normalized `partitions` + `event`).

## Broadcast to Origin

- The server must send `event_committed` to the origin client.
- Broadcasting to the origin client is **optional**; if it happens, the client
  must be idempotent by `id` / `committed_id`.

## Partition Subscriptions

- `partitions` are declared on `sync` requests, not on `connect`.
- The server treats the latest `sync` request’s partitions as the client’s
  current subscription set.
- The server only broadcasts events whose partitions intersect the
  connection’s current subscription.
- If a client adds a new partition, it must sync from `since_committed_id=0`
  (or maintain its own per-partition cursors).

## Limits & Backpressure

- Server should enforce a max message size (implementation-defined).
- Server should cap in-flight drafts per client (implementation-defined).
- On overload, server returns `rate_limited` and may close the connection.

## Storage Expectations

Server storage is **committed-only**:

- Append-only log of committed events.
- Index by `committed_id`.
- Store `partitions` as an array; optionally maintain an
  `event_partitions(id, partition)` index for fast membership queries.
- Optional snapshots (committed-only) to speed up sync.

## Retention / Compaction

- Because events can belong to multiple partitions, an event should only be
  pruned when **all** referenced partitions have advanced past its
  `committed_id` (or equivalent retention policy).

## Durability Guarantees

- `event_committed` / `event_broadcast` must only be sent **after** the committed
  event is durably persisted.
- On server restart, the commit log is the source of truth for replay and sync.
