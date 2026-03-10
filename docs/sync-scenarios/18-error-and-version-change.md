# Scenario 18 - Error Boundaries (Core)

Note: Envelope metadata (`msgId`, `timestamp`) is omitted when not central.

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
protocolVersion: "99.0"
payload:
  token: jwt
  clientId: C1
```

**Server -> C1**
```yaml
type: error
protocolVersion: "1.0"
payload:
  code: protocolVersion_unsupported
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
- Close behavior: `protocolVersion_unsupported`, `auth_failed`.
- Keep-open behavior: `bad_request`, `forbidden`.
