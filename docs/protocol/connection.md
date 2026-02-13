# Connection

This document defines the connection lifecycle: handshake, authentication, heartbeat, disconnect, and reconnect semantics.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Connection State

- Messages other than `connect` and `heartbeat` sent before `connected` **MUST** be rejected with `bad_request`.
- The server **MUST** bind a connection to the authenticated identity from JWT.
- If the same `client_id` connects while an existing connection is active, the server **MUST** close the older connection. Only one connection per `client_id` is allowed.

### State Machine

| State | Incoming | Condition | Action | Next State |
|------|----------|-----------|--------|------------|
| `await_connect` | `connect` | valid auth + supported version + supported profile | send `connected` | `active` |
| `await_connect` | `connect` | auth failure | send `error(auth_failed)`, close | `closed` |
| `await_connect` | `connect` | unsupported version | send `error(protocol_version_unsupported)`, close | `closed` |
| `await_connect` | `connect` | unsupported profile | send `error(profile_unsupported)`, close | `closed` |
| `await_connect` | `heartbeat` | any | send `heartbeat_ack` | `await_connect` |
| `await_connect` | any other message | any | send `error(bad_request)`, keep open | `await_connect` |
| `active` | `heartbeat` | any | send `heartbeat_ack` | `active` |
| `active` | `disconnect` | any | clear subscriptions, close | `closed` |
| `active` | `submit_events` / `sync` | valid message | process normally | `active` |
| `active` | `sync` | unauthorized partition/resource scope | send `error(forbidden)`, keep open | `active` |
| `active` | `submit_events` | unauthorized partition/resource scope | return `submit_events_result` with rejected item(s) (`reason=forbidden`), keep open | `active` |
| `active` | any message | malformed envelope/payload | send `error(bad_request)`, keep open | `active` |
| `active` | any authenticated request | auth identity mismatch / token expiry | send `error(auth_failed)` when applicable, close | `closed` |

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
  supported_profiles:           # optional, default [compatibility]
    - compatibility
    - canonical
  required_profile: compatibility   # optional hard requirement
  required_tree_policy: strict  # optional, relevant for tree profile (`compatibility`)
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
  capabilities:                    # required negotiated profile/capabilities
    profile: compatibility         # compatibility(tree) | canonical(event)
    accepted_event_types:
      - set
      - unset
      - treePush
      - treeDelete
      - treeUpdate
      - treeMove
    tree_policy: strict
  model_version: 3                # optional, present in event profile deployments
  limits:                         # optional: server-advertised limits
    max_batch_size: 100
    sync_limit_min: 50
    sync_limit_max: 1000
    max_message_bytes: 1048576
    max_in_flight_drafts: 200
```

Field semantics:
- `server_last_committed_id`: server's global high-watermark at handshake time. The client can use this to decide whether it needs to sync (if `server_last_committed_id > client's local cursor`, sync is needed).
- `capabilities` (required):
  - `profile`: selected connection profile.
  - `accepted_event_types`: exact top-level `event.type` values accepted on this connection.
  - `tree_policy`: required when `profile=compatibility`.
- Profile names:
  - `compatibility`: tree profile (first-class dynamic/free-form interface).
  - `canonical`: event profile (`type: event` envelope).
- For `profile=canonical`, `accepted_event_types` **MUST** be exactly `[event]`.
- For `profile=compatibility`, `accepted_event_types` **MUST** include only tree action types (`set`, `unset`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`).
- This spec defines `tree_policy=strict` only. Clients **MUST** treat other values as unsupported.
- `model_version` (optional): current model/domain schema version for event profile deployments. If the client's local snapshot has a different version, it **MUST** invalidate and re-sync. Model/version upgrades are deployment-driven (no dynamic `version_changed` push message in protocol `1.0`).
- `limits` (optional): server-advertised operational limits. If omitted, clients **MUST** use protocol defaults where defined (`max_batch_size=100`, `sync_limit_min=50`, `sync_limit_max=1000`) and treat other limits as unknown.

Profile negotiation semantics:
- If `required_profile` is present, server **MUST** either select it or fail connect with `profile_unsupported`.
- If `supported_profiles` is present, selected `capabilities.profile` **MUST** be one of them.
- If `supported_profiles` is omitted, server **MUST** assume the client supports `compatibility` only.
- If `required_tree_policy` is present and `capabilities.profile=compatibility`, server **MUST** satisfy it or fail connect with `profile_unsupported`.
- Selected profile **MUST** remain fixed for the lifetime of the connection.

## Auth Rules

- Server **validates JWT only** (signature + `exp`).
- Token is issued by an external auth service (not by this server).
- Required claim: `client_id` (**MUST** match `payload.client_id`).
- Partition/resource authorization **MUST** be enforced for `submit_events` and `sync` partition scopes.
- Authorization source **MAY** be JWT claims, server-side ACLs, or both.
- A common JWT shape is `allowed_partitions` (exact ids) and/or `allowed_partition_prefixes` (namespace prefixes).
- On auth failure: server **MUST** send `error` with code `auth_failed` and close the connection.
- For all post-connect messages, the authenticated connection identity is authoritative. `payload.client_id` is untrusted input and **MAY** be omitted by clients. If present and mismatched, server **MUST** reject with `auth_failed`.
- For committed storage and outbound messages, server **MUST** write the authenticated `client_id`, not any caller-provided value.
- `connect` does not establish partition subscriptions; clients declare partitions in `sync` requests.
- `sync` requests containing unauthorized partitions **MUST** be rejected with `forbidden` and return no event data.
- For `submit_events`, an event is authorized only if the client is authorized for **all** partitions in that event.
- Unauthorized submit items **MUST** be rejected with reason `forbidden` (without closing the connection).
- If the JWT expires during a long-lived connection, the server **MUST** close the connection. Token refresh requires a new `connect`.

## Heartbeat & Timeouts

- Client **MUST** send `heartbeat` on a regular interval (implementation-defined).
- Server **MUST** reply with `heartbeat_ack`.
- If no heartbeat is received within the server's timeout window, the server **MUST** close the connection.

## Disconnect

- A client that is intentionally closing **SHOULD** send `disconnect` first so the server can release subscription state immediately.

## Reconnect

- Reconnects **MUST** re-run `connect` and then `sync`.
- All subscriptions are removed on connection close; clients **MUST** re-establish them via `sync` with `subscription_partitions`.
