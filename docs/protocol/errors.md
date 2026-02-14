# Error Codes

This document defines the minimal canonical error set.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Error Codes

| Code | Connection | Meaning |
|------|-----------|---------|
| `auth_failed` | close | Invalid/expired token or authenticated identity mismatch. |
| `protocol_version_unsupported` | close | Unsupported `protocol_version`. |
| `bad_request` | keep open | Malformed message, missing required fields, or unknown message type. |
| `forbidden` | keep open | Authenticated client lacks required partition/resource access. |
| `validation_failed` | keep open | Event payload or domain validation failure. |
| `rate_limited` | close | Connection exceeded server inbound safety limits. |
| `server_error` | close | Unexpected internal failure. |

## Error Payload

```yaml
type: error
protocol_version: "1.0"
payload:
  code: bad_request
  message: Missing payload.events
  details: {}
```

Fields:

- `code` (string, required)
- `message` (string, required)
- `details` (object, optional)

## Recovery Guidance

- `auth_failed`: reconnect with fresh credentials.
- `protocol_version_unsupported`: reconnect using supported version.
- `bad_request`: fix payload and retry.
- `forbidden`: change scope/ACL before retry.
- `validation_failed`: correct event data before retry.
- `rate_limited`: back off, reconnect, then resume `sync`/draft retry.
- `server_error`: reconnect, sync, retry pending drafts by `id`.

## Server Error Mapping

- On unexpected internal exception, server **MUST** send `error` with `code=server_error` and then close the connection.
- Server **SHOULD** include minimally useful diagnostics in `details` when safe to expose.

Example:

```yaml
type: error
protocol_version: "1.0"
payload:
  code: server_error
  message: Unexpected server error
  details:
    phase: submit_events
```
