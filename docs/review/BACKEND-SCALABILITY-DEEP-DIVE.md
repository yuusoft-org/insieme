# Backend Scalability Deep-Dive: Horizontal Scaling to 10K+ Concurrent Connections

**Date:** 2026-05-08  
**Scope:** Line-level analysis of horizontal scalability limitations in the Insieme sync server, with a concrete architecture proposal for scaling to 10,000+ concurrent WebSocket connections.  
**Files Analyzed:** `src/sync-server.js` (1,047 lines), `src/ws-server-bridge.js` (155 lines), `src/ws-server-runtime.js` (85 lines), `src/sqlite-sync-store.js` (448 lines), `src/libsql-sync-store.js` (384 lines), `src/in-memory-sync-store.js` (141 lines), `src/command-sync-session.js` (279 lines), `src/partition-scope.js`, `src/payload-codec.js`, `src/libsql-driver.js`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Limitation #1: O(n) Broadcast Scan — `broadcastCommitted`](#limitation-1-on-broadcast-scan)
3. [Limitation #2: Single-Process Session Map — No Cross-Process Coordination](#limitation-2-single-process-session-map)
4. [Limitation #3: Sequential `commitOrGetExisting` — Write Throughput Ceiling](#limitation-3-sequential-commit-throughput-ceiling)
5. [Limitation #4: No Connection Pooling — 1:1 Connection-to-Session Model](#limitation-4-no-connection-pooling)
6. [Limitation #5: No Batch Commit Support — One Event at a Time](#limitation-5-no-batch-commit-support)
7. [Limitation #6: No Read Replicas for Sync Queries](#limitation-6-no-read-replicas)
8. [Limitation #7: No Message Queue for Reliable Delivery](#limitation-7-no-message-queue)
9. [Limitation #8: No Project-Level Sharding](#limitation-8-no-project-level-sharding)
10. [Limitation #9: Per-Session Receive Queue Serialization](#limitation-9-per-session-receive-queue)
11. [Limitation #10: No Backpressure Mechanisms](#limitation-10-no-backpressure)
12. [Proposed Architecture: Scaling to 10K+ Connections](#proposed-architecture)
13. [Implementation Roadmap](#implementation-roadmap)
14. [Performance Modeling](#performance-modeling)

---

## Executive Summary

The Insieme server is a **single-process, in-memory, single-writer** system. This report identifies **10 specific scalability bottlenecks** found through line-level code analysis, each with precise code references, quantitative impact analysis, and a proposed fix. The architecture proposal at the end synthesizes these into a coherent design for 10K+ concurrent connections across multiple server processes.

**Current estimated ceiling:** ~500–1,000 concurrent connections on a single process before latency degrades unacceptably (primarily due to O(n) broadcast, single-writer SQLite, and sequential event commits).

**Target:** 10,000+ concurrent connections across 3–5 server processes with p99 broadcast latency < 100ms and p99 commit latency < 50ms.

---

## Limitation #1: O(n) Broadcast Scan

### Code Location

```
sync-server.js:425-447 — broadcastCommitted()
```

### Current Implementation

```js
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipients = [...sessions.values()].filter(
    (session) =>
      session.state === "active" &&
      session.transport.connectionId !== originConnectionId &&
      !session.syncInProgress &&
      session.activeProjectId === committedEvent.projectId,
  );

  for (const session of recipients) {
    const broadcastMsgId = createServerMsgId();
    await sendMessage(session.transport, "event_broadcast", committedEvent, {
      msgId: broadcastMsgId,
    });
  }
};
```

### Detailed Analysis

**Time Complexity:** O(total_sessions × payload_size) per broadcast.

The `[...sessions.values()]` creates an intermediate array of ALL sessions, then `.filter()` iterates every entry. With 10K sessions across 200 projects, a broadcast for project X still scans 9,950 sessions belonging to other projects.

**Memory Impact:** The spread operator `[...sessions.values()]` materializes all session objects into an array. With 10K sessions at ~500 bytes/session metadata + transport references, this creates a ~5MB transient array per broadcast invocation.

**Sequential Send:** The `for...of await sendMessage()` sends broadcasts sequentially. If recipient A has a slow network buffer (e.g., `ws.send()` buffers because the TCP window is full), every subsequent recipient B, C, D... waits. A single slow client can add 100ms+ to the tail latency of every broadcast.

**Invocation Frequency:** Called once per committed event. From `handleSubmit` (line 742-747):
```js
for (const committedEvent of committedEvents) {
  await broadcastCommitted({
    originConnectionId: session.transport.connectionId,
    committedEvent,
  });
}
```
A `submit_events` message with 50 events triggers 50 sequential broadcastCommitted calls, each scanning all sessions.

**Quantitative Impact at 10K Connections:**

| Metric | 1K Sessions | 5K Sessions | 10K Sessions |
|--------|-------------|-------------|--------------|
| Scan time (array + filter) | ~0.1ms | ~0.5ms | ~1ms |
| Recipients (50/50 project, ~5% per-project) | 50 | 250 | 500 |
| Sequential send (0.1ms/send) | 5ms | 25ms | 50ms |
| **Total broadcast latency (1 event)** | ~5ms | ~26ms | ~51ms |
| **Total broadcast latency (50 events)** | ~250ms | ~1,300ms | ~2,550ms |

At 10K connections, a batch of 50 events takes **2.5 seconds** just for broadcasting. This is unacceptable.

### Proposed Fix

**1. Per-project session index (O(project_sessions) instead of O(all_sessions)):**

```js
// Add to createSyncServer:
const projectSessionIndex = new Map(); // projectId → Set<connectionId>

// On session connect (handleConnect success):
const projectSet = projectSessionIndex.get(projectId) || new Set();
projectSet.add(session.transport.connectionId);
projectSessionIndex.set(projectId, projectSet);

// On session close:
const projectSet = projectSessionIndex.get(session.activeProjectId);
if (projectSet) {
  projectSet.delete(session.transport.connectionId);
  if (projectSet.size === 0) projectSessionIndex.delete(session.activeProjectId);
}
```

**2. Parallel fan-out with backpressure:**

```js
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const projectSessions = projectSessionIndex.get(committedEvent.projectId);
  if (!projectSessions || projectSessions.size === 0) return;

  const sends = [];
  for (const connectionId of projectSessions) {
    if (connectionId === originConnectionId) continue;
    const session = sessions.get(connectionId);
    if (!session || session.state !== "active" || session.syncInProgress) continue;

    sends.push(
      sendMessage(session.transport, "event_broadcast", committedEvent, {
        msgId: createServerMsgId(),
      }).catch(() => {}) // swallow send failures
    );
  }
  await Promise.allSettled(sends);
};
```

**3. Batch broadcast (send all events from one submit together):**

Instead of calling `broadcastCommitted` per event, collect all committed events and send them as a batch:

```js
// Replace lines 742-747 in handleSubmit:
if (committedEvents.length > 0) {
  await broadcastCommittedBatch({
    originConnectionId: session.transport.connectionId,
    committedEvents,
  });
}
```

**Resulting Performance at 10K Connections:**

| Metric | Before | After |
|--------|--------|-------|
| Scan time (per broadcast) | ~1ms (all sessions) | ~0.05ms (project index) |
| Send latency (500 recipients, parallel) | ~50ms (sequential) | ~2ms (parallel) |
| Batch of 50 events | ~2,550ms | ~100ms (single batch broadcast) |
| **Improvement** | — | **~25x** |

---

## Limitation #2: Single-Process Session Map — No Cross-Process Coordination

### Code Location

```
sync-server.js:176 — const sessions = new Map();
ws-server-runtime.js:32 — const bridges = new Map();
```

### Current Implementation

The `sessions` Map is a local variable inside `createSyncServer`. There is no mechanism to share it across processes, persist it, or coordinate with other server instances.

```js
const sessions = new Map();  // line 176
// ...
sessions.set(transport.connectionId, session);  // line 1004
sessions.delete(connectionId);  // line 210
```

The `bridges` Map in `ws-server-runtime.js` duplicates this tracking:
```js
const bridges = new Map();  // line 32
bridges.set(bridge.connectionId, bridge);  // line 49
bridges.delete(bridge.connectionId);  // line 58
```

### Detailed Analysis

**Single-Server Constraint:** If two clients (Client A on Server 1, Client B on Server 2) are subscribed to the same project, Client A's event commit on Server 1 broadcasts only to Server 1's local sessions. Client B never receives the event — it must wait for the next explicit `sync` request.

**Session Loss on Crash:** Server restart = all 10K sessions destroyed. Every client must:
1. Detect the WebSocket close (or keep-alive timeout after 30s).
2. Reconnect (triggering a new TCP + WebSocket handshake).
3. Re-authenticate (token verification round-trip).
4. Re-sync from their last known cursor position.

For 10K clients simultaneously reconnecting, this creates a **thundering herd**: 10K concurrent sync requests hitting the database, potentially overwhelming it.

**No Fleet Visibility:** There is no way to answer "how many total active sessions are there?" or "which server is Client X connected to?" without querying every server individually.

**Session Data Size per Connection:**

```js
// sync-server.js:992-1001 — session shape
{
  transport: { connectionId, send, close },  // ~100 bytes (references)
  state: "await_connect" | "active" | "closed",  // string
  identity: { clientId, claims },  // ~200 bytes
  activeProjectId: "proj_xxx",  // ~50 bytes
  syncInProgress: false,  // boolean
  syncToCommittedId: null,  // null or number
  rateWindowStartedAt: 0,  // number
  rateWindowCount: 0,  // number
}
```

Estimated ~400-600 bytes per session (excluding transport). At 10K sessions: ~5MB. At 100K: ~50MB. Memory is not the immediate concern — coordination is.

### Proposed Fix

**Redis Session Registry with local caching:**

```
Redis Key Design:
  insieme:session:{connectionId}  → Hash { serverId, clientId, projectId, state, connectedAt }
  insieme:project:{projectId}:sessions  → Set of connectionIds
  insieme:server:{serverId}:heartbeat  → TTL-based key (refreshed every 10s)
```

```js
// On connect (after auth succeeds):
await redis.hset(`insieme:session:${connectionId}`, {
  serverId: SERVER_ID,
  clientId,
  projectId,
  state: "active",
  connectedAt: Date.now(),
});
await redis.sadd(`insieme:project:${projectId}:sessions`, connectionId);

// On disconnect:
await redis.del(`insieme:session:${connectionId}`);
await redis.srem(`insieme:project:${projectId}:sessions`, connectionId);

// Server heartbeat (every 10 seconds):
await redis.set(`insieme:server:${SERVER_ID}:heartbeat`, Date.now(), { EX: 30 });
```

**Stale session cleanup (runs on any server, every 60s):**
```js
const serverIds = await redis.keys("insieme:server:*:heartbeat");
for (const key of serverIds) {
  if (!(await redis.exists(key))) {
    const deadServerId = key.split(":")[2];
    // Clean up sessions belonging to deadServerId
    // (requires scanning insieme:session:* entries where serverId matches)
  }
}
```

**Thundering Herd Mitigation on Reconnect:**
- Client-side: Use the existing exponential backoff reconnect with jitter (already implemented in `sync-client.js:450-459`).
- Server-side: Add a connect rate limiter (e.g., max 100 new connects/sec per server, queue the rest with 503 + Retry-After).

---

## Limitation #3: Sequential `commitOrGetExisting` — Write Throughput Ceiling

### Code Location

```
sync-server.js:692 — await store.commitOrGetExisting(...)
sync-server.js:552 — for (let index = 0; index < payload.events.length; index += 1)
sqlite-sync-store.js:253-317 — commitTxn (synchronous BEGIN IMMEDIATE transaction)
libsql-sync-store.js:229-283 — commitOrGetExisting (async INSERT...ON CONFLICT DO NOTHING)
```

### Current Implementation

In `handleSubmit` (sync-server.js:552-731), events are committed one at a time in a `for` loop:

```js
for (let index = 0; index < payload.events.length; index += 1) {
  // ... validation ...
  try {
    const { deduped, committedEvent } = await store.commitOrGetExisting({
      ...normalizedItem,
      now: clock.now(),
    });
    // ...
    committedEvents.push(committedEvent);
  } catch (err) { /* ... */ }
}
```

Each `commitOrGetExisting` call does:

**SQLite (sqlite-sync-store.js:253-317):**
```js
commitTxn = createTransaction(db, ({ id, ... }) => {
  // 1. SELECT by id (dedup check)
  const existing = getByIdStmt.get({ id });
  // 2. If exists: compare canonicalized payloads, return deduped
  // 3. If not: INSERT, then SELECT back to read committed_id
  insertCommittedStmt.run({ ... });
  const inserted = getByIdStmt.get({ id });
  return { deduped: false, committedEvent: parseCommittedRow(inserted) };
});
```

This is wrapped in `BEGIN IMMEDIATE` which acquires an exclusive write lock for the entire transaction. Since SQLite is single-writer, concurrent `commitOrGetExisting` calls from different sessions queue behind each other.

**LibSQL (libsql-sync-store.js:229-283):**
```js
// Two network round-trips per event:
const insertResult = await db.execute("INSERT ... ON CONFLICT(id) DO NOTHING", [...]);
const insertedOrExisting = await getById(id);  // SELECT by id
```

### Detailed Analysis

**SQLite Throughput Model:**

| Parameter | Value |
|-----------|-------|
| WAL sync time (FULL) | ~5-10ms per commit |
| WAL sync time (NORMAL) | ~1-3ms per commit |
| Single commit (SELECT + INSERT + SELECT) | ~0.5ms (in-memory) + sync |
| **Max sustained writes/sec (FULL)** | ~100-200/sec |
| **Max sustained writes/sec (NORMAL)** | ~300-500/sec |

At 10K connections with an average of 1 event/sec per connection: 10K writes/sec. SQLite can handle ~200-500/sec. **20-50x under capacity.**

**LibSQL Throughput Model:**

| Parameter | Value |
|-----------|-------|
| Network RTT (same region) | 5-20ms |
| Two round-trips per commit | 10-40ms |
| **Max sustained writes/sec (single connection)** | ~25-100/sec |

With connection pooling (e.g., 10 concurrent LibSQL connections): 250-1,000 writes/sec. Still well below 10K/sec.

**Per-Submit Overhead:** A `submit_events` with 10 events requires 10 sequential `commitOrGetExisting` calls. At 20ms per LibSQL call, that's 200ms for a single submit.

### Proposed Fix

**1. Batch Commit (SQLite):**

```js
// New method: commitBatch
commitBatch: async ({ items, now }) => {
  ensureInitialized();
  return batchCommitTxn({ items, now });
};

const batchCommitTxn = createTransaction(db, ({ items, now }) => {
  const results = [];
  for (const item of items) {
    const existing = getByIdStmt.get({ id: item.id });
    if (existing) {
      // dedup check...
      results.push({ deduped: true, committedEvent: parseCommittedRow(existing) });
      continue;
    }
    insertCommittedStmt.run({ ... });
    const inserted = getByIdStmt.get({ id: item.id });
    results.push({ deduped: false, committedEvent: parseCommittedRow(inserted) });
  }
  return results;
});
```

Single transaction, single WAL sync. 10 events become 1 sync instead of 10. **~10x throughput improvement.**

**2. Batch Commit (LibSQL):**

Use LibSQL's batch/transaction API:
```js
const batchCommit = async ({ items, now }) => {
  // Use libSQL batch execution
  await client.batch([
    // BEGIN
    { sql: "BEGIN IMMEDIATE" },
    // All SELECTs and INSERTs as separate statements
    ...items.flatMap(item => [
      { sql: "INSERT INTO committed_events(...) VALUES (...) ON CONFLICT(id) DO NOTHING",
        args: [...] },
    ]),
    { sql: "COMMIT" },
  ]);

  // Read back all committed events in one round-trip
  const ids = items.map(i => i.id);
  const rows = await db.queryAll(
    `SELECT ... FROM committed_events WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  // Match rows back to items...
};
```

This reduces 20 round-trips (10 events × 2 RTT each) to ~2-3 round-trips. **~7-10x improvement.**

**3. Switch `synchronous` from FULL to NORMAL (SQLite):**

```js
// sqlite-sync-store.js line 52: synchronous = "FULL"
// Change default to:
synchronous = "NORMAL"  // Safe with WAL, ~3x faster writes
```

WAL mode + `synchronous=NORMAL` is safe against database corruption (only the last few transactions may be lost on power failure, not the entire DB). This is the standard high-performance SQLite configuration used by production systems.

**Combined throughput improvement:** ~30-50x over current sequential approach.

---

## Limitation #4: No Connection Pooling — 1:1 Connection-to-Session Model

### Code Location

```
sync-server.js:991-1038 — attachConnection()
ws-server-bridge.js:49-65 — session = syncServer.attachConnection(transport)
ws-server-runtime.js:42-65 — onConnection handler
```

### Current Implementation

Every WebSocket connection creates a dedicated session object:

```js
// ws-server-runtime.js:42-55
const onConnection = (ws, request) => {
  const bridge = attachWsConnection({ syncServer, ws, ... });
  bridges.set(bridge.connectionId, bridge);
  activeConnections += 1;
  // ...
};
```

Each connection carries:
- 1 session object (Map entry in `sessions`)
- 1 bridge object (Map entry in `bridges`)
- 1 keep-alive `setInterval` timer
- 3 event listeners (`message`, `close`, `pong`)
- 1 receive queue promise chain
- 1 WebSocket object (file descriptor)

### Detailed Analysis

**File Descriptor Limits:** Each WebSocket is a TCP connection = 1 file descriptor. Default `ulimit -n` is often 1024. Must be raised to >10K:
```bash
ulimit -n 65536  # or configure in systemd/docker
```

**Node.js Memory per Connection:** Each `ws` WebSocket instance uses ~10-20KB of memory (buffers, parser state, etc.). At 10K connections: ~100-200MB just for WebSocket objects.

**Timer Overhead:** 10K `setInterval` timers (keep-alive) fire every 30 seconds. That's ~333 timer callbacks/second. While lightweight, this is unnecessary — a single shared timer could sweep all connections.

**Event Listener Accumulation:** 3 listeners × 10K connections = 30K active event listeners. Node.js event emitter has O(k) lookup where k = listeners per event, so this is fine per-se. But `ws.on("message", onMessage)` creates a closure for each connection, capturing the `bridge` object. V8 must keep these closures alive.

**libuv Thread Pool:** The `ws` library handles framing on the main thread. Under high message throughput, the event loop may be blocked by JSON.parse of large messages. The `onMessage` handler in `ws-server-bridge.js:96-113` does synchronous JSON.parse:

```js
const onMessage = async (raw) => {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const parsed = JSON.parse(text);  // Synchronous, blocks event loop
  await session.receive(parsed);
};
```

A 256KB message payload takes ~5-10ms to parse, blocking all other I/O on that event loop tick.

### Proposed Fix

**1. Shared keep-alive sweep (replace per-connection intervals):**

```js
// Replace per-connection setInterval with a single sweep:
const keepAliveSweep = setInterval(() => {
  for (const ws of activeWebSockets) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, keepAliveIntervalMs);
```

Reduces 10K timers to 1.

**2. Connection limiting:**

```js
const MAX_CONNECTIONS = 15_000; // Leave headroom above target 10K
const onConnection = (ws, request) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    ws.close(503, "server_at_capacity");
    return;
  }
  // ... proceed
};
```

**3. Async JSON parsing for large messages:**

```js
// For messages > threshold, use worker threads or chunked parsing:
const LARGE_MESSAGE_THRESHOLD = 64 * 1024; // 64KB
const onMessage = async (raw) => {
  const text = /* ... */;
  if (text.length > LARGE_MESSAGE_THRESHOLD) {
    // Offload to worker thread
    const parsed = await parseInWorker(text);
    await session.receive(parsed);
  } else {
    await session.receive(JSON.parse(text));
  }
};
```

---

## Limitation #5: No Batch Commit Support — Events Committed One at a Time

### Code Location

```
sync-server.js:552-731 — handleSubmit() loop
```

### Current Implementation

Despite the protocol supporting multiple events in a single `submit_events` message, each event is committed individually:

```js
for (let index = 0; index < payload.events.length; index += 1) {
  // ... validation per event ...
  const { deduped, committedEvent } = await store.commitOrGetExisting({
    ...normalizedItem,
    now: clock.now(),
  });
  // ...
}
```

This means the store interface has no `commitBatch` method. The store contract (defined in the JSDoc at sync-server.js:141) only exposes:
```js
commitOrGetExisting: (input) => Promise<{ deduped: boolean, committedEvent: object }>
```

### Detailed Analysis

**Impact:** Already covered in [Limitation #3](#limitation-3-sequential-commit-throughput-ceiling). The key insight is that the store interface itself doesn't support batch operations — adding batch commits requires both a new store method AND changes to `handleSubmit`.

**Validation Sequentiality:** The current design validates events sequentially in the for-loop, with a "blockedById" circuit breaker (lines 554-557): if one event fails validation, all subsequent events are marked `not_processed`. This sequential validation with early-out is a correctness feature but prevents parallelism.

### Proposed Fix

Extend the store interface with a batch method and modify `handleSubmit`:

```js
// New store interface method:
commitBatch: async ({ items, now }) => {
  // items: Array<NormalizedItem>
  // Returns: Array<{ deduped: boolean, committedEvent: object }>
}

// Modified handleSubmit:
const handleSubmit = async (session, payload, context = {}) => {
  // Phase 1: Validate ALL events (sequential, with early-out for correctness)
  const validated = [];
  let blockedById = null;
  for (let i = 0; i < payload.events.length; i++) {
    if (blockedById) { /* mark not_processed */ continue; }
    const validatedItem = validateEvent(payload.events[i], session, context);
    if (validatedItem.error) {
      blockedById = validatedItem.id;
      continue;
    }
    validated.push(validatedItem);
  }

  // Phase 2: Batch commit all validated events
  if (validated.length > 0 && store.commitBatch) {
    const committedResults = await store.commitBatch({
      items: validated,
      now: clock.now(),
    });
    // Build results array...
  } else {
    // Fallback: sequential commitOrGetExisting
  }

  // Phase 3: Batch broadcast
  await broadcastCommittedBatch({ originConnectionId, committedEvents });
};
```

---

## Limitation #6: No Read Replicas for Sync Queries

### Code Location

```
sync-server.js:840-845 — store.listCommittedSince(...)
sqlite-sync-store.js:358-431 — listCommittedSince (paginated scan)
```

### Current Implementation

`handleSync` reads events from the same database connection used for writes:

```js
const handleSync = async (session, payload, context = {}) => {
  // ...
  const page = await store.listCommittedSince({
    projectId: normalizedProjectId,
    sinceCommittedId: rawSince,
    limit,
    syncToCommittedId: session.syncToCommittedId,
  });
  // ...
};
```

In the SQLite store, `listCommittedSince` (lines 394-417) uses a paginated scan:

```js
while (!exhausted && matched.length <= limit) {
  const rows = listRangeStmt.all({
    project_id: projectId,
    since_committed_id: cursor,
    upper_bound: upperBound,
    limit: pageSize,
  });
  // ...
}
```

With WAL mode, readers don't block writers and vice versa — but all readers share the same database file handle and compete for the same OS-level file read lock.

### Detailed Analysis

**Read/Write Ratio:** In a typical collaborative app, sync reads (clients pulling missed events after reconnect) vastly outnumber writes. Estimated ratio: 10:1 to 100:1 reads:writes.

**SQLite WAL Read Concurrency:** SQLite WAL mode allows multiple concurrent readers, which is good. But all reads go through the same process and file descriptor. At high read concurrency (1K concurrent `listCommittedSince` queries), the OS file descriptor becomes a bottleneck.

**LibSQL Remote:** With LibSQL, every sync query is a network round-trip to the remote database. If the remote database has a connection limit (e.g., Turso's per-database connection pool), concurrent syncs can exhaust it.

### Proposed Fix

**SQLite: Use embedded replicas (Turso) or separate read connection:**

```js
// SQLite: Open a second connection in read-only mode for sync queries
const readDb = new Database(dbPath, { readonly: true });
const readStore = createSqliteSyncStore(readDb, { journalMode: "WAL" });

// Sync server config:
{
  store: {
    commitOrGetExisting: writeStore.commitOrGetExisting,  // writes go to primary
    listCommittedSince: readStore.listCommittedSince,     // reads from read replica
  }
}
```

**LibSQL: Use Turso embedded replicas:**

```js
import { createClient } from '@libsql/client';

const writeClient = createClient({ url: 'libsql://primary.turso.io', ... });
const readClient = createClient({ url: 'file:local-replica.db', ... });
// Read from local replica (zero network latency), write to remote primary.
```

**PostgreSQL at scale:**

```sql
-- Read replicas via streaming replication
-- Application connects to read replica for sync queries:
SELECT ... FROM committed_events
WHERE project_id = $1 AND committed_id > $2 AND committed_id <= $3
ORDER BY committed_id ASC LIMIT $4;
```

---

## Limitation #7: No Message Queue for Reliable Delivery

### Code Location

```
sync-server.js:425-447 — broadcastCommitted (fire-and-forget)
ws-server-bridge.js:51-54 — ws.send(JSON.stringify(message)) (no delivery guarantee)
```

### Current Implementation

Broadcasts are fire-and-forget. The server calls `transport.send()` which calls `ws.send()`:

```js
// ws-server-bridge.js:51-54
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}
```

`ws.send()` is non-blocking — it buffers the data in the kernel TCP send buffer and returns immediately. There is no acknowledgment from the client, no retry on failure, and no persistent queue.

### Detailed Analysis

**Lost Messages Scenario:**
1. Client A submits event X.
2. Server commits X and calls `broadcastCommitted` for Clients B, C, D.
3. Client B's TCP buffer is full (slow network). `ws.send()` buffers in userspace.
4. Client B's WebSocket disconnects before the buffer drains.
5. Event X is lost for Client B. Client B must explicitly `sync` to catch up.

**Current Mitigation:** The sync protocol itself is the fallback — clients periodically call `sync` to pull missed events. This is correct but relies on clients proactively syncing, not on the server guaranteeing delivery.

**At 10K connections:** During a server restart, all 10K clients lose their in-flight broadcasts. All 10K must reconnect and re-sync. The database receives 10K concurrent `listCommittedSince` queries, each scanning the committed_events table.

### Proposed Fix

**Short-term (accept current model — sync is the delivery guarantee):**

Document that broadcasts are best-effort hints, and sync is the authoritative catch-up mechanism. This is already the de facto design and is correct.

**Medium-term (server-side delivery tracking):**

```js
// Track last delivered committedId per session
session.lastDeliveredCommittedId = committedEvent.committedId;

// On reconnect (handleConnect), automatically trigger sync from lastDeliveredCommittedId
// This reduces the "gap" between last delivered and last committed
```

**Long-term (message queue for critical events):**

```
Redis Stream: insieme:pending:{connectionId}
  - On broadcast: XADD with the event
  - On client ACK: XDEL the event
  - On reconnect: XRANGE to deliver pending events
```

This adds reliable delivery at the cost of Redis overhead per broadcast. Only recommended for critical events (not for every event in a high-throughput system).

---

## Limitation #8: No Project-Level Sharding

### Code Location

```
sqlite-sync-store.js:90-107 — Single committed_events table
libsql-sync-store.js:82-101 — Same schema
```

### Current Implementation

All projects share a single `committed_events` table:

```sql
CREATE TABLE IF NOT EXISTS committed_events (
  committed_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  -- ...
);
CREATE INDEX IF NOT EXISTS committed_events_project_committed_idx
  ON committed_events(project_id, committed_id);
```

### Detailed Analysis

**Index Bloat:** With 200 projects × 1M events/project = 200M rows, the composite index `(project_id, committed_id)` is ~200M × ~50 bytes = ~10GB. Each `listCommittedSince` query scans a range within this index, which is efficient per-query but the total index size strains memory.

**Autoincrement Contention:** The `committed_id INTEGER PRIMARY KEY AUTOINCREMENT` is a single global sequence. Every insert across every project competes for the same sequence counter. In SQLite, this is managed internally but still serialized.

**Noisy Neighbor:** A project with 10K events/sec monopolizes the write lock, starving other projects' writes. The `busy_timeout=5000ms` means other writers wait up to 5 seconds — but if the high-write project fills the WAL faster than checkpoints can run, all other projects see elevated latency.

**Vacuum/Maintenance:** SQLite `VACUUM` and checkpointing operate on the entire database. There's no way to maintain/optimize one project's data independently.

### Proposed Fix

**Level 1: Application-level sharding (SQLite):**

```js
// One database file per project:
const getStoreForProject = (projectId) => {
  if (!storeCache.has(projectId)) {
    const db = new Database(`data/projects/${projectId}.db`);
    const store = createSqliteSyncStore(db, { journalMode: "WAL" });
    store.init();
    storeCache.set(projectId, store);
  }
  return storeCache.get(projectId);
};

// Evict unused stores from cache (LRU):
if (storeCache.size > MAX_OPEN_DATABASES) {
  const [oldestProject] = storeCache.keys().next().value;
  const oldestStore = storeCache.get(oldestProject);
  oldestStore.close?.();
  storeCache.delete(oldestProject);
}
```

**Level 2: Database-per-project (LibSQL/Turso):**

Turso natively supports creating separate databases. Each project gets its own database with its own schema, write throughput, and storage quota.

```js
const getStoreForProject = async (projectId) => {
  // Each project gets its own Turso database
  const client = createClient({ url: `libsql://${projectId}.turso.io` });
  return createLibsqlSyncStore(client);
};
```

**Level 3: PostgreSQL partitioning:**

```sql
-- Declarative partitioning by project_id
CREATE TABLE committed_events (
  committed_id BIGSERIAL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- ...
  PRIMARY KEY (committed_id, project_id)
) PARTITION BY HASH (project_id);

-- Create N partitions
CREATE TABLE committed_events_p0 PARTITION OF committed_events FOR VALUES WITH (MODULUS 16, REMAINDER 0);
CREATE TABLE committed_events_p1 PARTITION OF committed_events FOR VALUES WITH (MODULUS 16, REMAINDER 1);
-- ...
```

---

## Limitation #9: Per-Session Receive Queue Serialization

### Code Location

```
sync-server.js:1003-1033 — receiveQueue promise chain
```

### Current Implementation

Each session has a receive queue that serializes message processing:

```js
let receiveQueue = Promise.resolve();

return {
  receive: async (message) => {
    receiveQueue = receiveQueue
      .catch(() => {})
      .then(async () => {
        await handleMessage(session, message);
      });
    return receiveQueue;
  },
};
```

### Detailed Analysis

**Correctness:** This prevents concurrent processing of messages from the same client (e.g., two `submit_events` arriving back-to-back won't interleave their commits). This is correct and important for maintaining causal ordering.

**Performance Impact:** If a `submit_events` with 50 events takes 200ms to process (sequential commits + broadcasts), any subsequent message from the same client (including a `sync` request) waits 200ms. The client's rate limiter window (1 second) may expire during this wait, causing the next message to be rate-limited.

**Promise Chain Growth:** Each message appends a `.then()` to the chain. V8 resolves completed promises efficiently, but under extreme rates (100+ messages/sec per session), the chain creates GC pressure.

**Cross-Session Impact:** The queue is per-session, so different sessions CAN process messages concurrently. This is good — one slow session doesn't block others. However, all sessions share the same event loop, database connection, and broadcast function. A burst of 100 concurrent `handleSubmit` calls (from 100 different sessions) creates 100 concurrent `commitOrGetExisting` calls, all contending for the same SQLite write lock.

### Proposed Fix

**Short-term:** Keep the per-session queue. It's correct and the overhead is minimal.

**Medium-term:** Add a global write queue to prevent database contention:

```js
const writeQueue = new PQueue({ concurrency: 1 }); // For SQLite single-writer
// Or: const writeQueue = new PQueue({ concurrency: 10 }); // For LibSQL pooled connections

// In handleSubmit:
const results = await writeQueue.add(() => store.commitBatch({ items, now }));
```

This serializes database writes without blocking the event loop for reads (sync queries).

---

## Limitation #10: No Backpressure Mechanisms

### Code Location

```
ws-server-bridge.js:51-54 — ws.send() with no backpressure check
sync-server.js:434-446 — sequential await sendMessage in broadcast
```

### Current Implementation

```js
// ws-server-bridge.js:51-54
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
  // No check on ws.bufferedAmount
}
```

The `ws` library's `send()` method buffers data when the TCP send buffer is full. `ws.bufferedAmount` tracks the number of bytes queued for transmission. The server never checks this.

### Detailed Analysis

**Slow Client Problem:** If a client has a slow network (e.g., mobile on 3G, or a client that stops reading), `ws.bufferedAmount` grows. The server keeps calling `send()`, buffering more and more data in memory.

**Memory Impact:** If the server broadcasts 10 events/sec × 5KB/event to a slow client that can only drain 1 event/sec, the buffer grows at ~45KB/sec. After 10 minutes: ~27MB per slow client. With 10 slow clients: ~270MB.

**Broadcast Amplification:** `broadcastCommitted` sends to ALL matching sessions. If 5% of 10K sessions (500) are slow, each broadcast creates 500 buffered messages. At 100 broadcasts/sec: 50,000 buffered messages/sec.

### Proposed Fix

**1. Per-session backpressure check:**

```js
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB

send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    // Pause sending to this client
    // Mark session as "paused" — skip in broadcast
    session.state = "backpressure";
    return;
  }
  ws.send(JSON.stringify(message));
}
```

**2. Backpressure-aware broadcast:**

```js
// In broadcastCommitted:
for (const session of recipients) {
  if (session.transport.ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    // Skip — client will catch up via sync later
    continue;
  }
  sends.push(sendMessage(session.transport, "event_broadcast", committedEvent));
}
```

**3. Resume detection:**

```js
// In keep-alive sweep:
if (ws.bufferedAmount < RESUME_THRESHOLD) {
  session.state = "active"; // Resume broadcasting
  // Optionally trigger sync to catch up missed events
}
```

---

## Proposed Architecture: Scaling to 10K+ Connections

### Target Topology

```
                        ┌─────────────────────────┐
                        │    Load Balancer         │
                        │  (AWS ALB / Caddy /      │
                        │   Cloudflare Spectrum)   │
                        │  Sticky routing by IP    │
                        │  Health: GET /health     │
                        └───────────┬─────────────┘
                                    │
                  ┌─────────────────┼──────────────────┐
                  │                 │                   │
           ┌──────▼──────┐   ┌─────▼──────┐    ┌──────▼──────┐
           │  Insieme    │   │  Insieme   │    │  Insieme   │
           │  Server #1  │   │  Server #2 │    │  Server #3 │
           │  (Node.js)  │   │  (Node.js) │    │  (Node.js) │
           │             │   │            │    │            │
           │ 3K-4K conn  │   │ 3K-4K conn│    │ 3K-4K conn │
           │ each        │   │ each       │    │ each       │
           └──────┬──────┘   └─────┬──────┘    └──────┬──────┘
                  │                │                   │
                  │    ┌───────────▼────────────┐      │
                  └───►│    Redis Cluster        │◄─────┘
                       │                         │
                       │  DB 0: Pub/Sub          │
                       │    Channel: insieme:    │
                       │      broadcast:{projId} │
                       │                         │
                       │  DB 1: Session Registry │
                       │    Hash: insieme:       │
                       │      session:{connId}   │
                       │    Set: insieme:        │
                       │      project:{projId}:  │
                       │        sessions         │
                       │                         │
                       │  DB 2: Rate Limiting    │
                       │    Counter: insieme:    │
                       │      ratelimit:{projId} │
                       └───────────┬─────────────┘
                                   │
                  ┌────────────────┼─────────────────┐
                  │                │                  │
           ┌──────▼──────┐  ┌─────▼──────┐  ┌───────▼──────┐
           │  Turso /    │  │  Read      │  │  Write       │
           │  LibSQL     │  │  Replica   │  │  Primary     │
           │  Primary    │  │  (local    │  │  (remote)    │
           │             │  │   embedded)│  │              │
           └─────────────┘  └────────────┘  └──────────────┘
```

### Component Design

#### 1. Broadcast Bus (Redis Pub/Sub)

```js
// broadcast-bus.js
import { createClient } from 'redis';

export const createBroadcastBus = ({
  redisUrl,
  serverId,
  onBroadcast,  // callback: (committedEvent) => void
}) => {
  const subscriber = createClient({ url: redisUrl });
  const publisher = createClient({ url: redisUrl });
  const activeChannels = new Set();  // Channels this server is subscribed to

  const getChannel = (projectId) => `insieme:broadcast:${projectId}`;

  return {
    init: async () => {
      await subscriber.connect();
      await publisher.connect();
      await subscriber.subscribe(
        `insieme:server:${serverId}:*`,
        (message) => {
          const { originConnectionId, committedEvent, originServerId } = JSON.parse(message);
          if (originServerId === serverId) return;  // Don't re-process own broadcasts
          onBroadcast({ originConnectionId, committedEvent });
        },
      );
    },

    subscribeToProject: async (projectId) => {
      const channel = getChannel(projectId);
      if (activeChannels.has(channel)) return;
      await subscriber.subscribe(channel, (message) => {
        const data = JSON.parse(message);
        if (data.originServerId === serverId) return;
        onBroadcast(data);
      });
      activeChannels.add(channel);
    },

    unsubscribeFromProject: async (projectId) => {
      const channel = getChannel(projectId);
      if (!activeChannels.has(channel)) return;
      await subscriber.unsubscribe(channel);
      activeChannels.delete(channel);
    },

    publish: async ({ originConnectionId, committedEvent }) => {
      const channel = getChannel(committedEvent.projectId);
      await publisher.publish(channel, JSON.stringify({
        originConnectionId,
        committedEvent,
        originServerId: serverId,
      }));
    },

    close: async () => {
      await subscriber.quit();
      await publisher.quit();
    },
  };
};
```

#### 2. Modified sync-server.js with Broadcast Bus

```js
// Key changes to createSyncServer:

export const createSyncServer = ({
  auth,
  authz,
  validation,
  store,
  clock,
  logger = () => {},
  limits = {},
  broadcastBus = null,  // NEW: optional Redis pub/sub bus
  serverId = "local",  // NEW: unique server identifier
}) => {
  const sessions = new Map();
  const projectSessionIndex = new Map();  // NEW: projectId → Set<connectionId>
  // ... existing code ...

  // NEW: Local broadcast (same server) + remote broadcast (other servers)
  const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
    const projectId = committedEvent.projectId;
    const projectSessions = projectSessionIndex.get(projectId);

    if (!projectSessions || projectSessions.size === 0) return;

    // Parallel fan-out to local sessions
    const sends = [];
    for (const connectionId of projectSessions) {
      if (connectionId === originConnectionId) continue;
      const session = sessions.get(connectionId);
      if (!session || session.state !== "active" || session.syncInProgress) continue;

      sends.push(
        sendMessage(session.transport, "event_broadcast", committedEvent, {
          msgId: createServerMsgId(),
        }).catch(() => {})
      );
    }
    await Promise.allSettled(sends);

    // Publish to Redis for other servers
    if (broadcastBus) {
      await broadcastBus.publish({ originConnectionId, committedEvent });
    }
  };

  // NEW: Handle remote broadcasts from other servers
  const handleRemoteBroadcast = async ({ originConnectionId, committedEvent }) => {
    // Same as local broadcast but originConnectionId belongs to a different server,
    // so it won't be found in our local sessions — no need to exclude it
    const projectSessions = projectSessionIndex.get(committedEvent.projectId);
    if (!projectSessions) return;

    const sends = [];
    for (const connectionId of projectSessions) {
      const session = sessions.get(connectionId);
      if (!session || session.state !== "active" || session.syncInProgress) continue;
      sends.push(
        sendMessage(session.transport, "event_broadcast", committedEvent, {
          msgId: createServerMsgId(),
        }).catch(() => {})
      );
    }
    await Promise.allSettled(sends);
  };

  // ... in handleConnect, after setting activeProjectId:
  const projectSet = projectSessionIndex.get(projectId) || new Set();
  projectSet.add(session.transport.connectionId);
  projectSessionIndex.set(projectId, projectSet);
  if (broadcastBus) await broadcastBus.subscribeToProject(projectId);

  // ... in closeSession, before deleting session:
  if (session.activeProjectId) {
    const projectSet = projectSessionIndex.get(session.activeProjectId);
    if (projectSet) {
      projectSet.delete(session.transport.connectionId);
      if (projectSet.size === 0) {
        projectSessionIndex.delete(session.activeProjectId);
        if (broadcastBus) await broadcastBus.unsubscribeFromProject(session.activeProjectId);
      }
    }
  }
};
```

#### 3. Batch Commit Store Extension

```js
// Extended store interface:
const store = {
  commitOrGetExisting: async (input) => { ... },  // Existing, unchanged

  // NEW: Batch commit
  commitBatch: async ({ items, now }) => {
    // SQLite implementation: single BEGIN IMMEDIATE transaction
    // LibSQL implementation: batch API or single transaction
    // Returns: Array<{ deduped: boolean, committedEvent: object }>
  },
};
```

#### 4. Health Check and Metrics Server

```js
// health-server.js
import { createServer as createHttpServer } from 'http';
import client from 'prom-client';

export const createHealthServer = ({ syncServer, runtime, port = 9090 }) => {
  const register = new client.Registry();

  // Metrics
  const activeSessionsGauge = new client.Gauge({
    name: 'insieme_active_sessions',
    help: 'Currently active sessions',
    registers: [register],
  });
  const eventsCommittedCounter = new client.Counter({
    name: 'insieme_events_committed_total',
    help: 'Total events committed',
    labelNames: ['projectId'],
    registers: [register],
  });
  const commitDurationHistogram = new client.Histogram({
    name: 'insieme_commit_duration_seconds',
    help: 'Commit latency',
    labelNames: ['storeType'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  });

  const server = createHttpServer((req, res) => {
    if (req.url === '/health') {
      const activeConnections = runtime.getActiveConnections();
      const healthy = activeConnections < MAX_CONNECTIONS;  // Simple check
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        activeConnections,
        uptime: process.uptime(),
      }));
    } else if (req.url === '/metrics') {
      activeSessionsGauge.set(runtime.getActiveConnections());
      res.writeHead(200, { 'Content-Type': register.contentType });
      register.metrics().then(m => res.end(m));
    }
  });

  server.listen(port);
  return { server, register, metrics: { activeSessionsGauge, eventsCommittedCounter, commitDurationHistogram } };
};
```

---

## Implementation Roadmap

### Phase 1: Single-Server Optimization (2-3 weeks)

Effort: ~15 engineer-days. Enables 3K-5K concurrent connections on a single server.

| Task | Effort | Impact |
|------|--------|--------|
| Add per-project session index (`projectSessionIndex` Map) | 1 day | Eliminates O(n) broadcast scan |
| Change `synchronous` default from FULL to NORMAL | 0.5 day | 3x write throughput |
| Add `commitBatch` to store interface + SQLite implementation | 2 days | 10x batch write throughput |
| Parallelize broadcast with `Promise.allSettled` | 0.5 day | Eliminates head-of-line blocking |
| Batch broadcast (send all events from one submit together) | 1 day | 5-10x fewer WebSocket sends |
| Add backpressure check (`ws.bufferedAmount` threshold) | 1 day | Prevents memory leak from slow clients |
| Add max connections limit | 0.5 day | DDoS resilience |
| Add health check endpoint | 0.5 day | Load balancer compatibility |
| Add Prometheus metrics | 2 days | Observability |
| Add graceful shutdown with concurrent session close + drain | 1 day | Zero-downtime deployments |
| Shared keep-alive sweep (replace per-connection timers) | 0.5 day | Reduces timer overhead |
| Load test baseline with k6 | 2 days | Validate performance |

### Phase 2: Multi-Server Foundation (3-4 weeks)

Effort: ~20 engineer-days. Enables 10K+ concurrent connections across multiple servers.

| Task | Effort | Impact |
|------|--------|--------|
| Implement Redis Pub/Sub broadcast bus | 3 days | Cross-server broadcast |
| Integrate broadcast bus into sync-server | 2 days | Multi-server operation |
| Redis session registry (register/deregister on connect/disconnect) | 3 days | Fleet visibility |
| Server heartbeat + stale session cleanup | 2 days | Crash recovery |
| Sticky routing configuration (ALB target group) | 1 day | Correct request routing |
| Load balancer health check integration | 1 day | Auto-unregister unhealthy servers |
| Read replica for sync queries (LibSQL embedded replicas) | 3 days | Offload read traffic |
| Per-project rate limits (Redis counters) | 2 days | Multi-tenant isolation |
| Multi-server load test (k6 with 2+ servers) | 2 days | Validate cross-server behavior |
| Failover test (kill one server, verify reconnect) | 1 day | Resilience validation |

### Phase 3: Scale-Out Hardening (4-6 weeks)

Effort: ~30 engineer-days. Enables 50K+ connections with strong isolation.

| Task | Effort | Impact |
|------|--------|--------|
| Per-project database sharding (SQLite or Turso) | 5 days | Storage isolation |
| Connection draining with in-flight operation tracking | 3 days | Zero-dropped-connections deploys |
| Auto-scaling (Kubernetes HPA based on active connections) | 2 days | Elastic capacity |
| OpenTelemetry tracing | 3 days | End-to-end debugging |
| Rolling deployment strategy (k8s) | 2 days | Zero-downtime releases |
| Stress testing (10K+ connections, mixed workload) | 3 days | Validate at target scale |
| 24-hour soak test | 1 day | Memory leak detection |
| PostgreSQL migration path (if/when needed) | 5 days | Unbounded write scaling |

---

## Performance Modeling

### Single-Server Capacity (After Phase 1 Optimizations)

| Metric | Current | After Phase 1 | Improvement |
|--------|---------|---------------|-------------|
| Max concurrent connections | ~500-1K | ~3K-5K | 5-10x |
| Broadcast latency (1 event, 100 recipients) | ~15ms (sequential) | ~1ms (parallel + index) | 15x |
| Batch submit (10 events) | ~200ms | ~20ms (batch commit) | 10x |
| Write throughput (events/sec) | ~200-500 | ~3K-5K | 10-25x |
| Sync query latency (p99) | ~50ms | ~50ms (unchanged) | — |
| Memory per connection | ~20KB | ~15KB (shared timer) | 1.3x |

### Multi-Server Capacity (After Phase 2)

| Metric | 1 Server | 3 Servers | 5 Servers |
|--------|----------|-----------|-----------|
| Max concurrent connections | ~4K | ~12K | ~20K |
| Total write throughput | ~5K/sec | ~15K/sec | ~25K/sec |
| Cross-server broadcast latency | N/A | ~5ms (Redis pub/sub) | ~5ms |
| Single-server failure impact | 100% reconnect | ~33% reconnect | ~20% reconnect |
| Thundering herd on reconnect | ~4K concurrent syncs | ~4K concurrent syncs | ~4K concurrent syncs |

### Key Scaling Formula

```
Total capacity = min(
  servers × connections_per_server,
  db_write_throughput,
  redis_pubsub_throughput
)

For 10K concurrent connections:
  3 servers × 4K connections/server = 12K ✓
  LibSQL batch writes: ~5K writes/sec × 3 connections = 15K ✓
  Redis Pub/Sub: ~100K messages/sec (well above requirement) ✓
```

---

## Appendix: Critical Code Paths for Profiling

When load testing, attach `perf_hooks` measurement to these specific functions:

```js
import { performance } from 'perf_hooks';

// 1. handleSubmit — total time from receive to broadcast complete
// sync-server.js:449 (handleSubmit entry) → line 747 (last broadcastCommitted)

// 2. commitOrGetExisting — database write time
// sqlite-sync-store.js:333 (commitOrGetExisting entry) → line 346 (return)

// 3. broadcastCommitted — fan-out time
// sync-server.js:425 (broadcastCommitted entry) → line 447

// 4. handleSync — database read time
// sync-server.js:840 (listCommittedSince call) → line 845

// 5. transport.send — WebSocket send time (includes backpressure)
// ws-server-bridge.js:51 (send entry) → line 54
```

Recommended profiling thresholds:

| Function | p50 Target | p99 Target | p99.9 Target |
|----------|------------|------------|--------------|
| `commitOrGetExisting` | 1ms | 10ms | 50ms |
| `broadcastCommitted` (100 recipients) | 1ms | 5ms | 20ms |
| `listCommittedSince` (500 events) | 5ms | 20ms | 100ms |
| `handleSubmit` (10 events) | 15ms | 50ms | 200ms |
| `transport.send` | 0.1ms | 1ms | 5ms |

---

## Summary

The Insieme server has a clean, well-structured codebase with strong correctness guarantees (idempotent commits, per-session message serialization, rate limiting, proper cleanup). The scalability limitations are **infrastructure-shaped, not design-shaped** — the core protocol and data model are sound. The primary work is:

1. **O(n) broadcast → O(project_sessions)** with a per-project index + parallel fan-out
2. **Single-process → multi-process** with Redis Pub/Sub for cross-server broadcast
3. **Sequential commits → batch commits** with a new `commitBatch` store method
4. **Single database → sharded databases** for write throughput isolation
5. **No backpressure → bufferedAmount thresholds** to prevent memory leaks
6. **No observability → Prometheus + health checks** for production operations

The phased approach allows incremental scaling: Phase 1 optimizations alone bring single-server capacity from ~500 to ~3-5K connections. Phase 2 enables horizontal scaling to 10K+ with Redis Pub/Sub. Phase 3 adds isolation and resilience for production-grade 50K+ deployments.
