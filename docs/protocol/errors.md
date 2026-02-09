# Error Codes

This document defines the canonical error codes, their effect on the connection, and recovery guidance.

## Error Codes Table

| Code | Connection | Meaning |
|------|-----------|---------|
| `auth_failed` | close | Invalid JWT, expired token, or client_id mismatch. |
| `bad_request` | keep open | Malformed message, missing fields, or unknown message type. |
| `validation_failed` | keep open | Schema or model validation failure on submitted event. |
| `rate_limited` | keep open | Client exceeded allowed rate. Payload may include `retry_after_ms`. |
| `server_error` | close | Unexpected internal error. Client should reconnect and retry pending drafts. |
| `protocol_version_unsupported` | close | Unsupported protocol version. Payload includes `supported_versions: ["1.0"]`. |

## Recovery Guidance

### `server_error`

The client cannot know whether the operation was persisted. On reconnect, retry pending drafts — the server's idempotency-by-`id` guarantees correctness.

### `version_changed`

When the model version changes while clients are connected, the server sends `version_changed`. On receiving it, clients must invalidate snapshots for affected partitions and perform a full catch-up (`since_committed_id=0`). See [validation.md](validation.md#model-versioning) for details.
