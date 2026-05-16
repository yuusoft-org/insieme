# Scalability & Production Readiness Analysis

**Date:** 2026-05-08  
**Scope:** Production deployment at scale — horizontal scaling, session management, cross-server broadcast, database contention, monitoring, graceful shutdown, memory lifecycle, load testing, multi-tenancy.  
**Files Analyzed:** `src/sync-server.js`, `src/ws-server-runtime.js`, `src/ws-server-bridge.js`, `src/libsql-sync-store.js`, `src/sqlite-sync-store.js`, `docs/production-checklist.md`

---

## Executive Summary

Insieme is a well-architected real-time sync server with clean separation of concerns (protocol logic, transport bridge, storage), solid input validation, rate limiting, and idempotent commit semantics. However, the current architecture is fundamentally **single-process, single-server**: all sessions live in an in-memory `Map`, broadcasts iterate local sessions only, and the SQLite storage backend is a single-writer local file. This is suitable for small-to-medium deployments (hundreds of concurrent connections) but requires significant infrastructure work for production at scale (thousands to tens of thousands of concurrent connections across multiple servers).

This report identifies nine specific scalability concerns, rates their severity, and proposes a concrete production architecture.

---

## 1. Single-Process Architecture → Horizontal Scaling

### Current State

`createSyncServer()` is a pure factory function that returns `{ attachConnection, shutdown }`. Every call to `attachConnection` inserts into a local `sessions = new Map()`. There is no clustering, no shared state, and no process coordination. The server is designed to run as a single Node.js process.

### Severity: **Critical** (blocks >1 server deployment)

### Problems

- Cannot run more than one instance behind a load balancer without session-aware sticky routing.
- Even with sticky routing, failover loses all in-memory sessions on the crashed node.
- No mechanism to share state or coordinate between processes.

### Recommendations

| Approach | Complexity | Trade-offs |
|----------|-----------|------------|
| **Redis-backed session registry** | Medium | Sessions still local, but a Redis hash maps `connectionId → serverId`. New servers can discover which server owns a session. Requires sticky routing at the LB. |
| **Redis Pub/Sub broadcast bus** | Medium | Decouples broadcast from local process. Each server subscribes to project channels and re-broadcasts to local sessions. See §3. |
| **Stateless server + externalized state** | High | Move all mutable session state to Redis. Servers become truly interchangeable. Requires rewriting session management. |
| **Node.js cluster module** | Low | Shares the same port across N workers. Does **not** solve the cross-worker broadcast problem — each worker has its own `sessions` Map. Only adds CPU parallelism. |

**Recommended path:** Redis Pub/Sub bus + sticky routing. This provides the best incremental improvement without a full rewrite. See §7 for the full proposed architecture.

---

## 2. In-Memory Session Map → Multi-Server Session Management

### Current State

```js
// sync-server.js:176
const sessions = new Map();
```

Each session stores: `transport`, `state`, `identity`, `activeProjectId`, `syncInProgress`, `syncToCommittedId`, `rateWindowStartedAt`, `rateWindowCount`. This is ~200-500 bytes per session (plus transport references).

### Severity: **Critical** (blocks horizontal scaling)

### Problems

- If a client connects to Server A and another client on the same project connects to Server B, they cannot receive each other's broadcasts.
- Server restart loses all sessions — every client must reconnect and re-sync.
- No visibility into total active sessions across a fleet.

### Recommendations

**Short-term (sticky routing):**
- Configure the load balancer (AWS ALB, Cloudflare, nginx `ip_hash`) to route the same IP to the same server.
- Accept that a server failure causes all its sessions to reconnect.
- Publish session counts to a metrics endpoint per-server.

**Medium-term (Redis session registry):**
```
Redis Hash: insieme:sessions:{connectionId}
  → { serverId, clientId, projectId, state, connectedAt }
```
- On `attachConnection`: `HSET` the session.
- On `closeSession`: `HDEL` the session.
- On broadcast: look up sessions by `projectId` via a secondary index `insieme:project_sessions:{projectId} → Set<connectionId>`.
- Each server periodically heartbeats its liveness; stale sessions are garbage-collected.

**Memory estimate:** 10K sessions × 500 bytes = 5 MB in-process — not a concern for single-server memory. At 100K sessions, consider externalizing.

---

## 3. Per-Server Broadcast → Cross-Server Message Bus

### Current State

```js
// sync-server.js:425-447
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipients = [...sessions.values()].filter(
    (session) =>
      session.state === "active" &&
      session.transport.connectionId !== originConnectionId &&
      !session.syncInProgress &&
      session.activeProjectId === committedEvent.projectId,
  );
  for (const session of recipients) {
    await sendMessage(session.transport, "event_broadcast", committedEvent, { msgId: broadcastMsgId });
  }
};
```

This iterates **all sessions on the local process** and filters by `activeProjectId`. It is O(n) where n = total sessions on this server.

### Severity: **Critical** (broadcasts don't cross server boundaries)

### Problems

- A client on Server A submits an event. Only clients on Server A receive the broadcast.
- Performance degrades linearly with total session count, not per-project session count.
- Sequential `await sendMessage` for each recipient — a slow client blocks subsequent broadcasts.

### Recommendations

**Step 1: Per-project session index (local optimization)**
```
Map<projectId, Set<connectionId>>
```
- Maintain on `attachConnection` (after connect) and `closeSession`.
- Reduces broadcast filter from O(all sessions) to O(project sessions).

**Step 2: Redis Pub/Sub bus**
```
Channel: insieme:broadcast:{projectId}
Message: { originConnectionId, committedEvent, originServerId }
```
- On commit, the originating server `PUBLISH`es to the project channel.
- Every server `SUBSCRIBE`s to channels for projects with active local sessions.
- Each server re-broadcasts to its local sessions (excluding the origin connection).

**Step 3: Fan-out optimization**
- Use `Promise.allSettled()` instead of sequential `for...of await` for local broadcast delivery.
- Add a per-session send queue to prevent backpressure from one slow client affecting others.

**Alternative:** Use a dedicated message broker (NATS, RabbitMQ, AWS SNS) if Redis Pub/Sub's fan-out semantics are insufficient for very high throughput (>10K events/sec across all projects).

---

## 4. Database Contention Under High Write Load

### Current State

**SQLite store** (`sqlite-sync-store.js`):
- Uses `BEGIN IMMEDIATE` transactions for commits.
- WAL mode + `synchronous=FULL` + `busy_timeout=5000`.
- Single-writer: SQLite allows only one writer at a time.
- `INSERT ... ON CONFLICT(id) DO NOTHING` via prepared statements.
- `commitOrGetExisting` is synchronous (blocks the event loop).

**LibSQL store** (`libsql-sync-store.js`):
- Async, suitable for remote Turso/libSQL connections.
- Same `INSERT ... ON CONFLICT(id) DO NOTHING` pattern.
- Network round-trip per commit.
- `busy_timeout` pragma may not apply to remote connections.

### Severity: **High** (single-writer bottleneck for SQLite; network latency for LibSQL)

### Problems

| Backend | Bottleneck |
|---------|-----------|
| **SQLite (local file)** | Single writer. Under high write throughput, `BEGIN IMMEDIATE` transactions queue up. `busy_timeout=5000ms` means writers block up to 5 seconds before `SQLITE_BUSY`. With WAL, readers don't block, but writers still serialize. |
| **LibSQL (remote/Turso)** | Network RTT per commit (typically 10-50ms). Each `commitOrGetExisting` does: INSERT → SELECT (read-back). Two round-trips per event. Batch submit of 10 events = 20 round-trips. |

### Recommendations

**SQLite optimization:**
1. **Batch inserts:** Accumulate events from a single `submit_events` message and insert them in a single transaction (already partially done — all events in one `handleSubmit` call go through sequential `commitOrGetExisting` calls, but each is a separate transaction). Wrap the entire `handleSubmit` in one transaction.
2. **Reduce `synchronous` to `NORMAL`:** With WAL mode, `synchronous=NORMAL` is safe against corruption and significantly faster. The existing checklist says "or justify downgrade" — justify it: `NORMAL` + WAL is the standard high-performance SQLite configuration.
3. **Connection pooling is not applicable** (SQLite is file-local).
4. **Scale-out:** Use one SQLite database per project (sharding by `projectId`). This eliminates cross-project write contention.

**LibSQL optimization:**
1. **Use Turso's embedded replicas** for read-heavy workloads (sync reads from local replica, writes to remote primary).
2. **Batch remote writes:** Use libSQL's batch execution API to commit multiple events in one round-trip.
3. **Write-ahead buffer:** Queue events locally and flush to LibSQL in micro-batches (every 50ms or N events).
4. **Connection pooling:** Use a connection pool with the `@libsql/client` to allow concurrent requests to the remote database.

**At very high scale (>1K writes/sec per project):**
- Migrate to PostgreSQL with `INSERT ... ON CONFLICT DO NOTHING` (same dedup pattern).
- Use partitioned tables by `projectId`.
- Consider event sourcing with a dedicated append-only log (Kafka, Kinesis) and materialized views.

---

## 5. Monitoring, Metrics, and Health Checks

### Current State

- **Logging:** Structured log callback (`logger`) with events like `connected`, `submit_committed`, `broadcast_sent`, `rate_limited`, `server_error`. Good for debugging.
- **Metrics:** None. No counters, gauges, histograms, or health endpoints.
- **Health checks:** None. No HTTP endpoint for load balancer health checks.
- **Tracing:** No distributed tracing or correlation IDs across services.

### Severity: **High** (required for any production deployment)

### Recommendations

**Metrics to expose (Prometheus `/metrics` endpoint):**

| Metric | Type | Labels |
|--------|------|--------|
| `insieme_active_sessions` | Gauge | `projectId`, `serverId` |
| `insieme_total_connections` | Counter | `serverId` |
| `insieme_total_disconnections` | Counter | `reason`, `serverId` |
| `insieme_events_committed_total` | Counter | `projectId`, `partition` |
| `insieme_events_deduped_total` | Counter | `projectId` |
| `insieme_events_broadcast_total` | Counter | `projectId` |
| `insieme_sync_requests_total` | Counter | `projectId` |
| `insieme_sync_events_sent_total` | Counter | `projectId` |
| `insieme_rate_limited_total` | Counter | `serverId` |
| `insieme_message_too_large_total` | Counter | `serverId` |
| `insieme_submit_duration_seconds` | Histogram | `projectId` |
| `insieme_sync_duration_seconds` | Histogram | `projectId` |
| `insieme_broadcast_duration_seconds` | Histogram | `projectId` |
| `insieme_db_commit_duration_seconds` | Histogram | `storeType` |
| `insieme_db_query_duration_seconds` | Histogram | `storeType`, `operation` |

**Health check endpoint (`GET /health`):**
```json
{
  "status": "ok" | "degraded" | "unhealthy",
  "uptime_seconds": 12345,
  "active_connections": 42,
  "db_accessible": true,
  "last_commit_ts": 1715152800000
}
```
- Load balancer should route to `/health` and mark server unhealthy if non-200 or timeout.
- "degraded" if DB write latency > threshold; "unhealthy" if DB is unreachable.

**Implementation:**
- Use `prom-client` npm package for Prometheus metrics.
- Expose via a separate lightweight HTTP server (e.g., port 9090) alongside the WebSocket server.
- Add a `metrics` dependency injection to `createSyncServer` similar to `logger`.

**Alerting rules (Prometheus):**
```yaml
- alert: InsiemeHighErrorRate
  expr: rate(insieme_server_error_total[5m]) > 0.01
- alert: InsiemeHighCommitLatency
  expr: histogram_quantile(0.99, rate(insieme_db_commit_duration_seconds_bucket[5m])) > 1.0
- alert: InsiemeSessionDrop
  expr: rate(insieme_total_disconnections{reason="server_error"}[5m]) > 0.1
```

---

## 6. Graceful Shutdown and Drain

### Current State

```js
// sync-server.js:1040-1045
shutdown: async () => {
  const ids = [...sessions.keys()];
  for (const connectionId of ids) {
    await closeSession(connectionId, "shutdown");
  }
}
```

```js
// ws-server-runtime.js:71-78
closeAllConnections: async (reason = "server_close") => {
  const closing = [...bridges.values()].map((bridge) => bridge.close(reason));
  await Promise.allSettled(closing);
  bridges.clear();
  activeConnections = 0;
}
```

### Severity: **Medium** (functional but needs production hardening)

### Problems

- `shutdown()` in sync-server closes sessions **sequentially** with `for...of await`. With 10K sessions, this could take minutes if each `close` involves sending a WebSocket close frame and waiting.
- No drain period — in-flight `handleSubmit` or `handleSync` operations are not awaited before closing sessions.
- No signal handling (SIGTERM, SIGINT) — must be implemented by the hosting application.
- No coordination with the load balancer (no health check transition to "draining").

### Recommendations

```js
// Proposed production shutdown sequence:
async function gracefulShutdown(syncServer, runtime, httpServer, signal) {
  logger.info({ event: "shutdown_started", signal });

  // 1. Stop accepting new connections
  runtime.detach();              // Remove connection listener
  httpServer.close();            // Stop listening

  // 2. Signal "draining" to load balancer
  healthStatus = "draining";     // /health returns 503

  // 3. Wait for in-flight operations to complete
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  await drainInFlightOperations(drainDeadline);

  // 4. Close all WebSocket connections concurrently
  await runtime.closeAllConnections("server_shutdown");

  // 5. Close sync server sessions
  await syncServer.shutdown();

  // 6. Flush final metrics
  await metrics.flush();

  logger.info({ event: "shutdown_complete" });
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown(...));
process.on("SIGINT", () => gracefulShutdown(...));
```

**Key improvements:**
- Use `Promise.allSettled` for concurrent session closure (not sequential).
- Add a configurable drain timeout (e.g., 30 seconds).
- Track in-flight operations with a counter/queue for proper drain.
- Transition health check to 503 before closing connections.

---

## 7. Connection Lifecycle and Memory Leaks

### Current State

The connection lifecycle is well-handled:

- **On connect:** `attachConnection` creates session, adds to `sessions` Map, returns `{ receive, close }`.
- **On message:** Serialized via `receiveQueue` promise chain per session (prevents concurrent message processing).
- **On close:** `onClose` in bridge calls `session.close()`, which calls `closeSession()` which sets `state="closed"`, deletes from `sessions` Map, closes transport. Bridge cleans up its own `keepAliveTimer` interval and removes event listeners (`ws.off`).
- **Keep-alive:** Ping/pong with configurable interval (default 30s). Terminates dead connections.
- **Rate limiting:** Closes connections that exceed rate limits.
- **Server errors:** Catches exceptions in `handleMessage`, sends error, closes session.

### Severity: **Low-Medium** (generally sound, but some edge cases)

### Potential Issues

1. **Receive queue promise chain growth:** `receiveQueue = receiveQueue.catch(() => {}).then(...)` chains promises indefinitely. While V8's GC can handle resolved promise chains, under extreme message rates this could create GC pressure. The `.catch(() => {})` ensures a rejection doesn't break the chain, which is correct.

2. **Broadcast references to closed sessions:** `broadcastCommitted` filters on `session.state === "active"`, but a session could transition to "closed" between the filter check and `sendMessage`. The `transport.send` checks `ws.readyState !== ws.OPEN`, so this is safe but wastes CPU on closed-session iteration.

3. **No maximum session count:** No limit on total sessions. Under a connection flood (DDoS), the `sessions` Map grows unbounded. Rate limiting is per-session, not per-server.

4. **`nextServerMsgId` counter:** `let nextServerMsgId = 1` — an integer that grows indefinitely. Not a practical concern (JavaScript numbers are safe up to 2^53), but worth noting for very long-lived processes.

### Recommendations

- Add a **maximum concurrent connections** limit at the runtime level. Reject new connections (close with 503) when the limit is reached.
- Add periodic **stale session sweep** as a safety net: iterate sessions and close any that have been in `await_connect` state for > N seconds.
- Monitor `sessions.size` as a gauge metric and alert on unexpected growth.
- Consider adding a session TTL for long-lived idle connections (in addition to keep-alive).

---

## 8. Load Testing Strategy

### Current State

No load testing infrastructure found. The production checklist mentions `test:reliability:stress` but no dedicated load testing scripts or tools.

### Severity: **High** (cannot validate production readiness without load testing)

### Recommended Load Testing Plan

**Phase 1: Baseline (single server)**

| Test | Target | Metric |
|------|--------|--------|
| Connection capacity | Ramp to 10K concurrent WebSocket connections | Memory per connection, server CPU, event loop lag |
| Message throughput | 100 clients submitting 10 events/sec each | p50/p95/p99 commit latency, broadcast latency |
| Sync throughput | 1K clients syncing simultaneously | p50/p95/p99 sync page latency |
| Broadcast fan-out | 1 event to 1K subscribers | End-to-end broadcast latency |
| Mixed workload | 50% submit, 30% sync, 20% idle | Overall throughput and latency under realistic mix |

**Phase 2: Resilience**

| Test | Target |
|------|--------|
| Slow clients | Verify backpressure handling, no memory leak |
| Burst traffic | 10x normal load for 30 seconds |
| Long-running connections | 24-hour soak test with steady load |
| Database contention | Concurrent writers from multiple connections |
| Network partitions | Kill database connection mid-operation |

**Phase 3: Scale-out (multi-server)**

| Test | Target |
|------|--------|
| Cross-server broadcast | Verify Redis Pub/Sub delivery between 2+ servers |
| Failover | Kill one server, verify clients reconnect and re-sync |
| Rolling deployment | Deploy new version with zero dropped connections |

**Tools:**
- **k6** with `k6/ws` module for WebSocket load testing (scriptable in JS, good metrics).
- **Artillery** with WebSocket engine for simpler scenarios.
- **Custom Node.js harness** for protocol-specific tests (connect → submit → sync → verify).
- **Autocannon** for HTTP health-check endpoint benchmarking.

**Key metrics to capture:**
- Connections per second (connect rate)
- Messages per second (submit + sync + broadcast)
- p50/p95/p99 latency for commit, sync, and broadcast
- Memory usage over time (RSS, heapUsed, external)
- Event loop lag (`perf_hooks`)
- Database query latency percentiles

---

## 9. Multi-Tenancy Isolation

### Current State

Multi-tenancy is implemented via `projectId`:
- Auth: `authz.authorizeProject(identity, projectId)` gates access.
- Storage: All events share the same `committed_events` table, partitioned by `project_id`.
- Broadcast: Filtered by `activeProjectId`.
- Sessions: Each session is bound to a single `activeProjectId`.

### Severity: **Medium** (works for moderate scale, but has isolation limits)

### Problems

| Concern | Impact |
|---------|--------|
| **Noisy neighbor** | A project with high write volume monopolizes the SQLite writer lock or LibSQL connection pool. |
| **Data isolation** | All projects share the same table. A schema migration or corruption affects all tenants. |
| **No per-project rate limits** | `limits` in `createSyncServer` are global, not per-project. |
| **No per-project resource quotas** | No limit on storage or connections per project. |
| **Broadcast scan overhead** | `broadcastCommitted` scans all sessions. With 100 projects and 10K sessions, each broadcast checks 10K sessions for its project. |

### Recommendations

**Short-term (per-project indexes):**
```js
// Replace linear scan with O(1) project → sessions lookup
const projectSessions = new Map(); // projectId → Set<connectionId>
```
- Maintain on connect and disconnect.
- Broadcast becomes O(sessions in project) instead of O(all sessions).

**Medium-term (per-project rate limits and quotas):**
```js
limits: {
  perProject: {
    maxConnections: 1000,
    maxSubmitsPerMinute: 5000,
    maxStorageBytes: 1_000_000_000,
  }
}
```
- Track per-project counters in Redis for cross-server enforcement.

**Long-term (storage sharding):**
- **SQLite:** One database file per project (or per group of projects). Eliminates cross-tenant write contention.
- **LibSQL/Turso:** One database per project (Turso supports this natively).
- **PostgreSQL:** Partition `committed_events` by `project_id` (native declarative partitioning).

---

## Proposed Production Architecture

### Architecture Diagram (Conceptual)

```
                    ┌─────────────────┐
                    │   Load Balancer │ (sticky routing by IP)
                    │  (AWS ALB /     │
                    │   Cloudflare)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌────▼──────┐ ┌─────▼─────┐
       │  Insieme    │ │  Insieme  │ │  Insieme  │
       │  Server #1  │ │  Server #2│ │  Server #N│
       │  (Node.js)  │ │  (Node.js)│ │  (Node.js)│
       └──────┬──────┘ └────┬──────┘ └─────┬─────┘
              │              │              │
              │    ┌─────────▼──────────┐   │
              └───►│   Redis Cluster    │◄──┘
                   │  - Pub/Sub (broadcast)
                   │  - Session registry
                   │  - Per-project rate limits
                   │  - Drain coordination
                   └─────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐            ┌────────▼───────┐
       │   Turso /   │            │   PostgreSQL   │
       │   LibSQL    │            │   (per-project │
       │  (primary)  │            │    partitions) │
       └─────────────┘            └────────────────┘
```

### Infrastructure Recommendations

| Component | Recommended | Rationale |
|-----------|-------------|-----------|
| **Runtime** | Node.js 22+ or Bun | Current codebase uses ES modules, `Buffer`, `ws`. Both runtimes work. |
| **Process manager** | Docker + Kubernetes | Container orchestration with rolling deployments, health checks, auto-scaling. |
| **Load balancer** | AWS ALB or Cloudflare Spectrum | WebSocket support, sticky routing, TLS termination, DDoS protection. |
| **Session state** | Redis 7+ (Cluster mode) | Pub/Sub for broadcast, hashes for session registry, atomic counters for rate limits. |
| **Database (small scale)** | Turso (libSQL) with embedded replicas | Read-from-local, write-to-remote. Built-in replication. Per-project databases. |
| **Database (large scale)** | PostgreSQL 16+ with Citus or CockroachDB | Horizontal sharding, strong consistency, mature tooling. |
| **Metrics** | Prometheus + Grafana | `prom-client` in-server, Prometheus scrapes `/metrics`, Grafana dashboards. |
| **Logging** | Structured JSON → stdout → CloudWatch/Loki | Existing `logger` callback already outputs structured objects. Pipe to log aggregator. |
| **Tracing** | OpenTelemetry | Add trace propagation to WebSocket messages for end-to-end visibility. |
| **Secrets** | Vault / AWS Secrets Manager | Token verification keys, database credentials. |
| **CI/CD** | GitHub Actions → ECR → Kubernetes | Automated build, test, push, deploy with canary rollouts. |

### Scaling Milestones

| Stage | Concurrent Connections | Infrastructure |
|-------|----------------------|----------------|
| **Stage 1** (current) | 0–500 | Single server, local SQLite. Suitable for development and small teams. |
| **Stage 2** | 500–5,000 | Single server, LibSQL/Turso remote DB, Prometheus metrics, health checks, graceful shutdown. |
| **Stage 3** | 5,000–50,000 | 2–5 servers behind ALB with sticky routing, Redis Pub/Sub for broadcast, LibSQL or PostgreSQL. |
| **Stage 4** | 50,000+ | 10+ servers, PostgreSQL with partitioning, Redis Cluster, per-project database sharding, auto-scaling. |

---

## Priority Action Items

Ordered by impact and implementation effort:

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| **P0** | Add Prometheus metrics endpoint (`/metrics`) | 2–3 days | Observability foundation |
| **P0** | Add HTTP health check endpoint (`/health`) | 0.5 day | Required for any load balancer |
| **P0** | Implement graceful shutdown with SIGTERM handling and drain | 1 day | Zero-downtime deployments |
| **P0** | Add maximum concurrent connections limit | 0.5 day | DDoS resilience |
| **P1** | Add per-project session index for broadcast | 1 day | Performance at >1K sessions |
| **P1** | Implement Redis Pub/Sub broadcast bus | 3–5 days | Multi-server support |
| **P1** | Add load testing harness with k6 | 2–3 days | Validate performance claims |
| **P1** | Batch INSERT in handleSubmit (single transaction) | 1–2 days | 5–10x write throughput |
| **P2** | Redis session registry for cross-server visibility | 3–5 days | Fleet management |
| **P2** | Per-project rate limits and quotas | 2–3 days | Multi-tenant isolation |
| **P2** | Per-project database sharding | 5–10 days | Storage isolation at scale |
| **P3** | OpenTelemetry tracing integration | 3–5 days | End-to-end debugging |
| **P3** | Connection draining with in-flight operation tracking | 2–3 days | Production-grade shutdown |

---

## Summary

Insieme's core protocol design is solid — the event-sourced sync model, idempotent commits, per-session message serialization, and rate limiting are all well-implemented. The primary gap is **infrastructure for horizontal scaling**: the in-memory session model and local-only broadcast are the fundamental blockers for multi-server deployment.

The recommended approach is **incremental**: start with observability (P0 items) that benefit even a single-server deployment, then add the Redis Pub/Sub broadcast bus (P1) to enable multi-server operation, then progressively add session registry, per-project isolation, and database sharding as scale demands.

The existing `docs/production-checklist.md` covers network, runtime, durability, and CI concerns well. This report extends it with the scaling and operational infrastructure needed for production deployment at any meaningful scale.
