# Messages

This document defines the minimal wire envelope and message schemas for the Insieme sync protocol over WebSocket.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Message Envelope

All messages (both directions) **MUST** include:

- `type` (string): message type.
- `payload` (object): message-specific payload.
- `protocolVersion` (string): current version is `"1.0"`.

Optional metadata:

- `msgId` (string): trace/debug id.
- `timestamp` (number): sender time in ms.

Envelope rules:

- Unknown message `type` **MUST** be rejected with `bad_request`.
- Missing required envelope fields **MUST** be rejected with `bad_request`.
- Unsupported `protocolVersion` **MUST** be rejected with `protocolVersion_unsupported` and the connection **MUST** close.
- Unknown extra fields **MUST** be ignored for forward compatibility.
- Servers **MAY** enforce inbound safety limits (message rate/size). On limit breach, server returns `rate_limited` or `bad_request` and may close the connection.

## Client -> Server

### `connect`

```yaml
type: connect
protocolVersion: "1.0"
payload:
  token: jwt
  clientId: client-123
```

### `submit_events`

Core mode uses exactly one submitted event per request.

```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [workspace-1]
      projectId: workspace-1
      userId: user-123
      type: explorer.folderCreated
      payload: { id: A, name: Folder A }
      meta:
        clientId: client-123
        clientTs: 1738451200000
```

Rules:

- `payload.events` **MUST** be an array with exactly 1 item.
- `payload.events[0].id` **MUST** be present.
- `payload.events[0].partitions` **MUST** follow `partitions.md`.
- `payload.events[0].type` **MUST** be present.
- `payload.events[0].payload` **MUST** be an object.
- `payload.events[0].meta.clientId` **MUST** match the authenticated connection client.
- `payload.events[0].meta.clientTs` **MUST** be a finite number.
- `payload.events[0].meta` **MAY** include extra JSON-safe fields. Reserved keys may be overwritten by the runtime.

### `sync`

```yaml
type: sync
protocolVersion: "1.0"
payload:
  partitions:
    - workspace-1
  sinceCommittedId: 1200
  limit: 500
```

Rules:

- `sinceCommittedId` is exclusive.
- `limit` is optional.
- If omitted, server **MUST** use default `500`.
- If provided, server **MUST** clamp to `[1, 1000]`.

## Server -> Client

### `connected`

```yaml
type: connected
protocolVersion: "1.0"
payload:
  clientId: client-123
  globalLastCommittedId: 1700
```

### `submit_events_result`

Response to `submit_events`.

```yaml
type: submit_events_result
protocolVersion: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: committed
      committedId: 1201
      created: 1738451201500
```

Rejected example:

```yaml
type: submit_events_result
protocolVersion: "1.0"
payload:
  results:
    - id: evt-uuid-1
      status: rejected
      reason: validation_failed    # validation_failed | forbidden
      errors:
        - field: payload.id
          message: duplicate id
      created: 1738451201600
```

Rules:

- Server **MUST** send exactly one `submit_events_result` per `submit_events` request.
- `results` **MUST** contain exactly one entry in core mode.
- Origin submit outcome is authoritative from this message.

### `event_broadcast`

Sent to other clients to announce a committed event.

```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 1201
  id: evt-uuid-1
  partitions:
    - workspace-1
  projectId: workspace-1
  userId: user-123
  type: explorer.folderCreated
  payload: { id: A, name: Folder A }
  meta:
    clientId: client-123
    clientTs: 1738451200000
  created: 1738451205000
```

Server **MUST NOT** send `event_broadcast` for an item to the same connection that submitted that item.

### `sync_response`

```yaml
type: sync_response
protocolVersion: "1.0"
payload:
  partitions:
    - workspace-1
  events:
    - committedId: 1201
      id: evt-uuid-50
      partitions: [workspace-1]
      projectId: workspace-1
      userId: user-456
      type: explorer.folderCreated
      payload: { id: B, name: Folder B }
      meta:
        clientId: client-456
        clientTs: 1738451200000
      created: 1738451200000
  nextSinceCommittedId: 1700
  hasMore: false
  syncToCommittedId: 1700
```

Cursor rule:

- If `hasMore=true`, client **MUST** use `nextSinceCommittedId` in the next `sync` call.
- If `hasMore=false`, `nextSinceCommittedId` becomes the durable cursor.
- `payload.partitions` **MUST** be present and reflect the normalized active sync scope used for this response page.
- `payload.syncToCommittedId` **MUST** remain fixed for the full paging cycle.

### `error`

```yaml
type: error
protocolVersion: "1.0"
payload:
  code: bad_request
  message: Missing payload.events
  details: {}
```

See `errors.md` for the canonical code set.
