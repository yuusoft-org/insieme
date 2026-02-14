# Messages

This document defines the minimal wire envelope and message schemas for the Insieme sync protocol over WebSocket.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Message Envelope

All messages (both directions) **MUST** include:

- `type` (string): message type.
- `payload` (object): message-specific payload.
- `protocol_version` (string): current version is `"1.0"`.

Optional metadata:

- `msg_id` (string): trace/debug id.
- `timestamp` (number): sender time in ms.

Envelope rules:

- Unknown message `type` **MUST** be rejected with `bad_request`.
- Missing required envelope fields **MUST** be rejected with `bad_request`.
- Unsupported `protocol_version` **MUST** be rejected with `protocol_version_unsupported` and the connection **MUST** close.
- Unknown extra fields **MUST** be ignored for forward compatibility.
- Servers **MAY** enforce inbound safety limits (message rate/size). On limit breach, server returns `rate_limited` or `bad_request` and may close the connection.

## Client -> Server

### `connect`

```yaml
type: connect
protocol_version: "1.0"
payload:
  token: jwt
  client_id: client-123
```

### `submit_events`

Core mode uses exactly one submitted event per request.

```yaml
type: submit_events
protocol_version: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [workspace-1]
      event:
        type: event
        payload:
          schema: explorer.folderCreated
          data: { id: A, name: Folder A }
```

Rules:

- `payload.events` **MUST** be an array with exactly 1 item.
- `payload.events[0].id` **MUST** be present.
- `payload.events[0].partitions` **MUST** follow `partitions.md`.

### `sync`

```yaml
type: sync
protocol_version: "1.0"
payload:
  partitions:
    - workspace-1
  since_committed_id: 1200
  limit: 500
```

Rules:

- `since_committed_id` is exclusive.
- `limit` is optional and server-clamped.

## Server -> Client

### `connected`

```yaml
type: connected
protocol_version: "1.0"
payload:
  client_id: client-123
  server_last_committed_id: 1700
```

### `submit_events_result`

Response to `submit_events`.

```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committed_id: 1201
      status_updated_at: 1738451201500
```

Rejected example:

```yaml
type: submit_events_result
protocol_version: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: rejected
      reason: validation_failed    # validation_failed | forbidden
      errors:
        - field: event.payload.data.id
          message: duplicate id
      status_updated_at: 1738451201600
```

Rules:

- Server **MUST** send exactly one `submit_events_result` per `submit_events` request.
- `results` **MUST** contain exactly one entry in core mode.
- Origin submit outcome is authoritative from this message.

### `event_broadcast`

Sent to other clients to announce a committed event.

```yaml
type: event_broadcast
protocol_version: "1.0"
payload:
  id: evt-uuid-1
  client_id: client-123
  partitions:
    - workspace-1
  committed_id: 1201
  event:
    type: event
    payload:
      schema: explorer.folderCreated
      data: { id: A, name: Folder A }
  status_updated_at: 1738451205000
```

Server **MUST NOT** send `event_broadcast` for an item to the same connection that submitted that item.

### `sync_response`

```yaml
type: sync_response
protocol_version: "1.0"
payload:
  partitions:
    - workspace-1
  events:
    - id: evt-uuid-50
      client_id: client-456
      partitions: [workspace-1]
      committed_id: 1201
      event:
        type: event
        payload:
          schema: explorer.folderCreated
          data: { id: B, name: Folder B }
      status_updated_at: 1738451200000
  next_since_committed_id: 1700
  has_more: false
```

Cursor rule:

- If `has_more=true`, client **MUST** use `next_since_committed_id` in the next `sync` call.
- If `has_more=false`, `next_since_committed_id` becomes the durable cursor.
- `payload.partitions` **MUST** be present and reflect the normalized active sync scope used for this response page.

### `error`

```yaml
type: error
protocol_version: "1.0"
payload:
  code: bad_request
  message: Missing payload.events
  details: {}
```

See `errors.md` for the canonical code set.
