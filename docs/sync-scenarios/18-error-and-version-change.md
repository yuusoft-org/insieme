# Scenario 18 - Error Boundaries (Core)

Note: Envelope metadata (`msg_id`, `timestamp`) is omitted when not central.

## Goal
Verify core error handling boundaries: protocol version, auth, bad request, forbidden.

## Actors
- C1
- Server

## Steps

### 1) Unsupported protocol version

**C1 -> Server**
```yaml
type: connect
protocol_version: "99.0"
payload:
  token: jwt
  client_id: C1
```

**Server -> C1**
```yaml
type: error
protocol_version: "1.0"
payload:
  code: protocol_version_unsupported
  message: Unsupported protocol version
```

Connection closes.

### 2) Auth failure
- Connect with invalid/expired token.
- Server returns `auth_failed` and closes.

### 3) Bad request
- Send malformed `submit_events` shape (missing `payload.events`).
- Server returns `bad_request` and keeps connection open.

### 4) Forbidden scope
- Send `sync` for unauthorized partition.
- Server returns `forbidden` and keeps connection open.

## Assertions
- Close behavior: `protocol_version_unsupported`, `auth_failed`.
- Keep-open behavior: `bad_request`, `forbidden`.
