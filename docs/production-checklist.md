# Production Checklist

Use this checklist before production rollout.

## Network and Edge

- [ ] Enforce primary rate limits at edge/API gateway per IP and auth identity.
- [ ] Enforce transport max frame/message size at edge and WebSocket gateway.
- [ ] Set connection idle timeout and keepalive policy (ping/pong) at transport layer.

## Server Runtime

- [ ] Configure `createSyncServer({ limits })` with environment-specific values:
  - `maxInboundMessagesPerWindow`
  - `rateWindowMs`
  - `maxEnvelopeBytes`
- [ ] Monitor `error.code=rate_limited` and `message_too_large` logs.
- [ ] Ensure all structured logs include `connection_id`, `id`, `committed_id`, and `msg_id` when available.

## SQLite Durability

- [ ] Use WAL mode.
- [ ] Use `synchronous=FULL` (or justify downgrade).
- [ ] Set `busy_timeout` to a non-zero value for production.
- [ ] Run periodic integrity checks (`PRAGMA integrity_check`).
  Use `npm run ops:sqlite:integrity -- /path/to/client.db /path/to/server.db`.
- [ ] Back up database files with tested restore process.

## LibSQL / Turso Durability

- [ ] Use `@libsql/client` adapters: `createLibsqlClientStore` and `createLibsqlSyncStore`.
- [ ] Keep adapter `applyPragmas` disabled unless using local file URLs that support SQLite pragmas.
- [ ] Validate idempotent retry behavior against network interruptions and transient remote failures.
- [ ] Monitor database request latency and timeout/error rates in production telemetry.

## Crash Recovery

- [ ] Verify restart behavior with pending drafts and persisted commits.
- [ ] Verify duplicate submit retries remain idempotent after restart.
- [ ] Verify cursor monotonicity under reconnect and replay.

## CI and Release Gates

- [ ] `npm run lint` passes.
- [ ] `npm run test:ci` passes.
- [ ] `npm run test:coverage` passes threshold gates.
- [ ] `npm run test:reliability:stress` passes repeated runs.
- [ ] Publish only from non-dirty tree and tagged commit.
