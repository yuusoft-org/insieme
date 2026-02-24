# Minimal Protocol Core (Simplification Draft)

This is a design draft for future consideration. It is not part of the current protocol or implementation.

## Intent

Define the smallest protocol surface that still guarantees:
- deterministic server order (`committed_id`),
- idempotent retries (`id` dedupe),
- offline catch-up (`sync since_committed_id`),
- optimistic local drafts.

Everything else is deferred.

## Keep (Core Invariants)

1. `committed_id` is global, monotonic, never reused.
2. Event `id` is globally unique and used for dedupe.
3. Same `id` + same payload => return existing commit result.
4. Same `id` + different payload => reject.
5. Origin submit outcome is explicit response (not broadcast).

If any simplification breaks these, do not take it.

## Minimal Wire Surface

## Client -> Server

- `connect`
- `submit_event` (single event only; no batch)
- `sync`

## Server -> Client

- `connected`
- `submit_event_result`
- `sync_response`
- `event_broadcast`
- `error`

## Deferred from Core

- `disconnect` message (use normal socket close).
- App-level `heartbeat` / `heartbeat_ack` (use transport ping/pong).
- Batch submit (`submit_events` array).
- Profile negotiation (`canonical` vs `compatibility`) and capability exchange.
- `subscription_partitions` separate from sync scope.
- Server-advertised limits block.
- `msg_id` as required field (can remain optional trace metadata).
- Client `timestamp` as required field (can remain optional metadata).

## Simplified Message Shapes

Envelope (minimal):
- `type` (required)
- `payload` (required)
- `protocol_version` (required)

Optional metadata:
- `msg_id`
- `timestamp`

### `connect`

```yaml
type: connect
protocol_version: "1.0"
payload:
  token: jwt
  client_id: C1
```

### `connected`

```yaml
type: connected
protocol_version: "1.0"
payload:
  client_id: C1
  server_last_committed_id: 1200
```

### `submit_event`

```yaml
type: submit_event
protocol_version: "1.0"
payload:
  id: evt-uuid-1
  partitions: [P1]
  event: { ... }
```

### `submit_event_result`

```yaml
type: submit_event_result
protocol_version: "1.0"
payload:
  id: evt-uuid-1
  status: committed            # committed | rejected
  committed_id: 1201           # present when committed
  reason: validation_failed    # present when rejected
  errors: []                   # optional details
  status_updated_at: 1738451205000
```

### `sync`

```yaml
type: sync
protocol_version: "1.0"
payload:
  partitions: [P1]
  since_committed_id: 1200
  limit: 500
```

### `sync_response`

```yaml
type: sync_response
protocol_version: "1.0"
payload:
  partitions: [P1]
  events: [ ... ]
  next_since_committed_id: 1250
  has_more: false
```

### `event_broadcast`

```yaml
type: event_broadcast
protocol_version: "1.0"
payload:
  id: evt-uuid-9
  client_id: C2
  partitions: [P1]
  committed_id: 1251
  event: { ... }
  status_updated_at: 1738451210000
```

## Sync/Broadcast Simplification Rule

To remove client-side broadcast buffering complexity:

- While a connection has an active sync paging cycle (`has_more=true` not finished), server does not deliver `event_broadcast` to that connection.
- After final page (`has_more=false`), server resumes broadcasts.

This replaces high-watermark buffering logic with a simpler server-side rule.

## Simplified Error Set

Core errors only:
- `auth_failed` (close)
- `bad_request` (keep open)
- `forbidden` (keep open)
- `validation_failed` (keep open)

Deferred:
- `profile_unsupported`
- `protocol_version_unsupported` detail expansion
- `rate_limited`
- `server_error` specialization (can map to close + generic error first)

## Partition Rules (Minimal)

- Keep `partitions` as non-empty string array.
- Keep all-of authorization for submit and sync.
- Keep event visibility by partition intersection.

Defer initially:
- Unicode NFC normalization requirements.
- strict byte-order canonical sorting requirements in spec text.
- separate subscription replacement semantics.

## Validation Scope (Minimal)

- Validate event payload for the active application model only.
- Reject unknown event types.
- Reject malformed partition shape.
- Keep server-authoritative validation.

Defer:
- dual-profile negotiation,
- app-specific policy matrices beyond schema validation.

## Client Runtime Simplification

- Submit one event at a time in local draft order.
- Keep retry with same `id`.
- Apply commits idempotently by (`id`, `committed_id`).

Storage recommendation:
- 2-table model:
  - `local_drafts`
  - `committed_events`
- Optional third table for rejected-history only if product needs it.

## Migration Strategy

1. Introduce this as `core` profile, keep current protocol as `extended`.
2. New clients default to `core`.
3. Keep server support for both during transition.
4. Remove extended-only features after adoption.

## Tradeoff Summary

What you lose:
- protocol flexibility and feature negotiation,
- batch submit efficiency,
- richer ops telemetry in wire envelope.

What you gain:
- smaller protocol surface,
- fewer edge-case states,
- easier client implementation and testing,
- faster path to stable production behavior.
