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
  projectId: workspace-1
```

Rules:

- `payload.token` **MUST** be present.
- `payload.clientId` **MUST** be present.
- `payload.projectId` **MUST** be a non-empty string.

### `submit_events`

Core mode allows one or more submitted events per request.

```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partition: workspace-1
      projectId: workspace-1
      userId: user-123
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: A, name: Folder A }
      meta:
        clientId: client-123
        clientTs: 1738451200000
```

Rules:

- `payload.events` **MUST** be an array with at least 1 item.
- Each `payload.events[n].id` **MUST** be present.
- Each `payload.events[n].partition` **MUST** follow `partitions.md`.
- Each `payload.events[n].projectId` **MUST** be present and match the authenticated session project.
- Each `payload.events[n].type` **MUST** be present.
- Each `payload.events[n].schemaVersion` **MUST** be a positive integer.
- Each `payload.events[n].payload` **MUST** be an object.
- Each `payload.events[n].meta.clientId` **MUST** match the authenticated connection client.
- Each `payload.events[n].meta.clientTs` **MUST** be a finite number.
- Each `payload.events[n].meta` **MAY** include extra JSON-safe fields. Reserved keys may be overwritten by the runtime.
- Server **MUST** process items in request order.
- Server **MUST** stop attempting later items after the first rejected item in the same batch.

### `sync`

```yaml
type: sync
protocolVersion: "1.0"
payload:
  projectId: workspace-1
  sinceCommittedId: 1200
  limit: 500
```

Rules:

- `payload.projectId` **MUST** be present and match the authenticated session project.
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
  projectId: workspace-1
  projectLastCommittedId: 1700
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
      serverTs: 1738451201500
    - id: evt-uuid-2
      status: committed
      committedId: 1202
      serverTs: 1738451201501
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
    - id: evt-uuid-2
      status: not_processed
      reason: prior_item_failed
      blockedById: evt-uuid-1
      created: 1738451201600
```

Rules:

- Server **MUST** send exactly one `submit_events_result` per `submit_events` request.
- `results` **MUST** contain exactly one entry per submitted item, in request order.
- Result `status` values are `committed`, `rejected`, or `not_processed`.
- `committed` results **MUST** include `committedId` and `serverTs`.
- `results[n]` **MUST NOT** echo event fields such as `schemaVersion`; clients correlate outcomes by submitted `id`.
- If one item is rejected, later submitted items in the same batch that were not attempted **MUST** be returned as `not_processed`.
- Origin submit outcome is authoritative from this message.

### `event_broadcast`

Sent to other clients to announce a committed event.

```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 1201
  id: evt-uuid-1
  partition: workspace-1
  projectId: workspace-1
  userId: user-123
  type: explorer.folderCreated
  schemaVersion: 1
  payload: { id: A, name: Folder A }
  meta:
    clientId: client-123
    clientTs: 1738451200000
  serverTs: 1738451205000
```

Server **MUST NOT** send `event_broadcast` for an item to the same connection that submitted that item.
Committed broadcast events **MUST** include a positive-integer `schemaVersion`.

### `sync_response`

```yaml
type: sync_response
protocolVersion: "1.0"
payload:
  projectId: workspace-1
  events:
    - committedId: 1201
      id: evt-uuid-50
      partition: workspace-1
      projectId: workspace-1
      userId: user-456
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: B, name: Folder B }
      meta:
        clientId: client-456
        clientTs: 1738451200000
      serverTs: 1738451200000
  nextSinceCommittedId: 1700
  hasMore: false
  syncToCommittedId: 1700
```

Cursor rule:

- If `hasMore=true`, client **MUST** use `nextSinceCommittedId` in the next `sync` call.
- If `hasMore=false`, `nextSinceCommittedId` becomes the durable cursor.
- `payload.projectId` **MUST** be present and reflect the active project scope used for this response page.
- `payload.syncToCommittedId` **MUST** remain fixed for the full paging cycle.
- Each `payload.events[n].schemaVersion` **MUST** be present and be a positive integer.

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
