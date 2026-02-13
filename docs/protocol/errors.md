# Error Codes

This document defines the canonical error codes, their effect on the connection, and recovery guidance.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Error Codes Table

| Code | Connection | Meaning |
|------|-----------|---------|
| `auth_failed` | close | Invalid JWT, expired token, or client_id mismatch. |
| `bad_request` | keep open | Malformed message, missing fields, or unknown message type. |
| `validation_failed` | keep open | Schema or model validation failure on submitted event. |
| `forbidden` | keep open | Authenticated client lacks authorization for requested partition/resource scope. |
| `rate_limited` | keep open | Client exceeded allowed rate. Payload **MAY** include `details.retry_after_ms`. |
| `server_error` | close | Unexpected internal error. Client **SHOULD** reconnect and retry pending drafts. |
| `protocol_version_unsupported` | close | Unsupported protocol version. Payload includes `details.supported_versions` (for example `["1.0"]`). |
| `profile_unsupported` | close | Unsupported requested profile/capability set during `connect`. Payload includes `details.supported_profiles`. |

## Error Payload Shape

Use the common `error` payload from `messages.md`:
- `code` (string)
- `message` (string)
- `details` (object, optional) for code-specific metadata

## Code Selection Rules

Servers **MUST** choose error codes using the following boundaries:

- `protocol_version_unsupported`:
  - `protocol_version` provided but unsupported for this server.
  - Connection effect: close.
- `profile_unsupported`:
  - `connect` requested profile/capability set cannot be satisfied (for example `required_profile` unsupported, no overlap with `supported_profiles`, or unsupported `required_tree_policy`).
  - Connection effect: close.
- `auth_failed`:
  - JWT invalid/expired, authenticated identity mismatch, or post-connect `payload.client_id` mismatch.
  - Connection effect: close.
- `bad_request`:
  - Malformed envelope, unknown message `type`, invalid message for current connection state, missing required fields, or request-level batch invariants failure (for example duplicate ids in one `submit_events` request).
  - Connection effect: keep open.
- `validation_failed`:
  - Well-formed submit message where event/domain/partition constraints fail.
  - Connection effect: keep open.
- `forbidden`:
  - Authenticated client is not authorized for one or more requested partitions/resources.
  - Connection effect: keep open.
- `rate_limited`:
  - Quota/backpressure policy violation.
  - Connection effect: keep open by default (server **MAY** close under overload policy).
- `server_error`:
  - Unexpected internal failure where correctness cannot be guaranteed.
  - Connection effect: close.

## Recovery Guidance

### `server_error`

The client cannot know whether the operation was persisted. On reconnect, clients **MUST** retry pending drafts — the server's idempotency-by-`id` guarantees correctness.

### `forbidden`

Client should not retry unchanged. Update partition/resource scope (or credentials/ACL) before retrying.

### `profile_unsupported`

Retry `connect` using one of `details.supported_profiles` (or remove `required_profile`) if the client supports it.

### `version_changed`

When the model version changes while clients are connected in event profile (`canonical`) deployments, the server sends `version_changed` globally. On receiving it, clients **MUST** invalidate all local model snapshots and perform a full catch-up (`since_committed_id=0`) for all active model partitions. See [validation.md](validation.md#model-versioning) for details.
