# Insieme Backend: Robustness & Performance Plan

**Based on 3 deep-dive reports (2,584 lines total analysis).**
**16 robustness findings (4 critical). 16 performance findings (7 critical). 10 scalability limitations.**
**This document distills everything into an ordered, actionable implementation plan.**

---

## The 4 Fatal Bugs (Ship Blockers)

### F1. Broadcast failure cascades to all subscribers

**What happens now:** When event N is committed, `broadcastCommitted` loops through recipients sequentially with `await sendMessage`. If recipient A's WebSocket is dead, `sendMessage` throws, the loop aborts, and recipients B, C, D... never get the event. The error then propagates up to `handleSubmit`, which catches it and kills the *submitter's* session too.

```js
// CURRENT: sync-server.js line 434-446
for (const session of recipients) {
  await sendMessage(session.transport, "event_broadcast", committedEvent, ...);
  // ↑ If this throws, the rest of the loop is skipped, and the submitter dies
}
```

**Impact:** One dead WebSocket kills event delivery for every other subscriber and disconnects the person who submitted.

**Fix:**
```js
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipients = projectSessions.get(session.activeProjectId) ?? [];
  const tasks = recipients
    .filter(s => s.transport.connectionId !== originConnectionId && !s.syncInProgress)
    .map(s =>
      sendMessage(s.transport, "event_broadcast", committedEvent, { msgId: createServerMsgId() })
        .catch(err => {
          log({ event: "broadcast_failed", connectionId: s.transport.connectionId, error: String(err) });
          // Schedule dead-session cleanup, don't cascade
          scheduleSessionCleanup(s.transport.connectionId);
        })
    );
  await Promise.allSettled(tasks);
};
```

**Lines changed:** ~15 lines in sync-server.js.

---

### F2. Store commit error drops in-flight events silently

**What happens now:** If the store throws on event N in a batch, events 0..N-1 are already committed and broadcast. But the error propagates to `handleMessage`'s catch block, which sends `"server_error"` and closes the session — **without ever sending `submit_events_result`**. The client has no idea which events succeeded.

```js
// CURRENT: sync-server.js line 712-730
} catch (err) {
  // ...
  throw err;  // ← bubbles to handleMessage catch, kills session, no result sent
}
```

**Fix:**
```js
} catch (err) {
  // Convert store errors to rejected results instead of throwing
  const payloadError = toErrorPayload(err, "server_error", "Store commit failed");
  pushRejected(item.id, payloadError.code, payloadError.message);
  log({ event: "store_commit_error", id: item.id, error: String(err) });
  continue;  // Process remaining events in the batch
}

// Always send the result — the client deserves to know what happened
await sendMessage(session.transport, "submit_events_result", { results }, { msgId: context.msgId });
```

**Lines changed:** ~10 lines in handleSubmit.

---

### F3. No graceful shutdown — in-flight data lost

**What happens now:** `shutdown()` immediately closes all sessions. If a client just submitted 50 events and we're on event 25 (committed + broadcast, but `submit_events_result` not yet sent), the client has no idea which events went through. Reconnecting and resubmitting will hit dedup for 0-24 but the client had no confirmation.

**Fix:**
```js
shutdown: async () => {
  // Phase 1: Stop accepting new connections
  runtime.detach();
  
  // Phase 2: Stop accepting new messages
  shuttingDown = true;
  
  // Phase 3: Drain in-flight operations
  const drains = [...sessions.values()].map(s => s.inflight?.promise || Promise.resolve());
  await Promise.allSettled(drains);
  
  // Phase 4: Close sessions gracefully (sends close frames)
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map(id => closeSession(id, "shutdown")));
}
```

**Lines changed:** ~20 lines in sync-server.js + ws-server-runtime.js.

---

### F4. receiveQueue unhandled rejection

**What happens now:** The `receiveQueue` pattern chains promises with `.catch(() => {})`. But if `sendError` itself throws inside the catch block (e.g., transport is closed), the rejection escapes into the void. In Node.js, this triggers `unhandledRejection` which can crash the process.

```js
// CURRENT: sync-server.js line 1008-1032
receiveQueue = receiveQueue
  .catch(() => {})  // ← swallows the previous error
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch {
      await sendError(...);  // ← if this throws, the rejection is unhandled
      await closeSession(...);  // ← and this never runs
    }
  });
```

**Fix:**
```js
receiveQueue = receiveQueue
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch (err) {
      try { await sendError(session.transport, "server_error", "Unexpected error", {}, { msgId }); } catch {}
      try { await closeSession(session.transport.connectionId, "server_error"); } catch {}
    }
  })
  .catch(() => {});  // ← terminal catch, always last
```

**Lines changed:** ~10 lines in attachConnection.

---

## The 6 Performance Killers

### P1. O(n) broadcast scan on every commit [CRITICAL]

**What happens now:** `broadcastCommitted` does `[...sessions.values()].filter(...)` — iterates ALL sessions on every committed event. For a batch of N events and S total sessions: O(N × S).

```js
// CURRENT: sync-server.js line 426
const recipients = [...sessions.values()].filter(
  session => session.state === "active" && session.transport.connectionId !== originConnectionId &&
    !session.syncInProgress && session.activeProjectId === committedEvent.projectId
);
```

**Fix:** Per-project session index.

```js
const sessions = new Map();                    // connectionId → session
const projectSessions = new Map();             // projectId → Set<connectionId>

// On connect:
projectSessions.get(projectId)?.add(connectionId) or create Set;

// On disconnect:
projectSessions.get(projectId)?.delete(connectionId);

// On broadcast:
const recipientIds = projectSessions.get(committedEvent.projectId) ?? [];
// Only iterate sessions for THIS project
```

**Cost at 10K connections, 100 projects:** 10K iterations → 100 iterations. **100× improvement.**

---

### P2. Write amplification: 3 SQL statements per event [CRITICAL]

**What happens now (SQLite):** Each `commitOrGetExisting` executes:
1. `SELECT id FROM committed_events WHERE id = ?` — dedup check
2. `INSERT INTO committed_events ...` — insert
3. `SELECT * FROM committed_events WHERE committed_id = ?` — readback

Each in its own `BEGIN IMMEDIATE` transaction. **3 statements, 3 lock cycles per event.**

**Fix:** Batch commit + eliminate readback.

```js
// New store method: commitBatch
async commitBatch(items) {
  const db = this.db;
  const results = [];
  
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    // Batch dedup: one query
    const ids = items.map(i => i.id);
    const existing = db.prepare(
      `SELECT id, committed_id, server_ts FROM committed_events WHERE id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    const existingMap = new Map(existing.map(r => [r.id, r]));
    
    // Insert only new events
    const insertStmt = db.prepare(`INSERT INTO committed_events ...`);
    for (const item of items) {
      const existing = existingMap.get(item.id);
      if (existing) {
        results.push({ deduped: true, committedEvent: deserialize(existing) });
        continue;
      }
      const info = insertStmt.run(item.id, item.partition, ...);
      results.push({
        deduped: false,
        committedEvent: { ...item, committedId: info.lastInsertRowid, serverTs: item.now }
      });
    }
    
    db.prepare("COMMIT").run();
  } catch {
    db.prepare("ROLLBACK").run();
    throw;
  }
  
  return results;
}
```

**Cost per 50-event batch:** 150 statements → 3 statements (1 dedup SELECT + N inserts + 1 commit). **50× fewer lock cycles.**

---

### P3. No backpressure on WebSocket sends [CRITICAL]

**What happens now:** `ws.send(JSON.stringify(message))` is fire-and-forget. If a client is slow (mobile, bad connection), Node buffers the data in memory. At 10K slow clients each buffering 1MB: **10GB of untracked memory.**

```js
// CURRENT: ws-server-bridge.js line 53
ws.send(JSON.stringify(message));  // ← no backpressure, no bufferedAmount check
```

**Fix:**
```js
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  const data = JSON.stringify(message);
  
  // Backpressure: if buffer is already large, drop or wait
  if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
    log("backpressure_drop", { bufferedAmount: ws.bufferedAmount });
    // Option A: Drop broadcast messages (acceptable for real-time)
    if (message.type === "event_broadcast") return;
    // Option B: Wait for drain for critical messages
    await new Promise(resolve => ws.once("drain", resolve));
  }
  
  ws.send(data);
},
```

**Configuration:**
```js
const BACKPRESSURE_THRESHOLD = 64 * 1024;  // 64KB — reasonable for JSON messages
```

---

### P4. Per-event authorization check in batch [HIGH]

**What happens now:** `handleSubmit` calls `authz.authorizeProject(identity, item.projectId)` for **every event in the batch**, even though all events must have `projectId === session.activeProjectId` (enforced earlier in the loop).

```js
// CURRENT: sync-server.js line 652-659 — inside the per-event loop
const authorized = await authz.authorizeProject(session.identity, item.projectId);
// ↑ Same identity, same projectId, called N times
```

**Fix:** Check once, before the loop.
```js
// Before the loop:
const authorized = await authz.authorizeProject(session.identity, session.activeProjectId);
if (!authorized) { /* reject entire batch */ }

// Inside the loop: only validate projectId matches (already done)
```

**Cost per 50-event batch:** 50 authz calls → 1. If authz is a DB query: **50× fewer queries.**

---

### P5. Canonicalization on every commit including duplicates [HIGH]

**What happens now:** `canonicalizePayload` runs `deepSortKeys` + `JSON.stringify` on the full payload for every commit, even for duplicate events where the result is only used for comparison.

**Fix:** Short-circuit on dedup hit, or defer canonicalization.
```js
// Option A: Dedup first, canonicalize only on insert
const existing = await checkExists(id);
if (existing) return { deduped: true, existing };

// Only canonicalize if we're actually inserting
const canonicalPayload = canonicalizePayload(payload);
```

---

### P6. Sequential broadcast per event [HIGH]

**What happens now:** Events are broadcast one at a time:
```js
for (const committedEvent of committedEvents) {
  await broadcastCommitted({ originConnectionId, committedEvent });
}
```
If a batch commits 50 events, each one triggers a full broadcast pass. With the per-project index (P1), this is already much faster, but we can batch further:

**Fix:** Batch broadcast.
```js
const broadcastCommittedBatch = async ({ originConnectionId, events }) => {
  const recipients = (projectSessions.get(events[0].projectId) ?? [])
    .filter(cid => cid !== originConnectionId);
  
  // Send all events to each recipient in one pass
  const tasks = recipients.map(cid => {
    const session = sessions.get(cid);
    if (!session || session.syncInProgress) return Promise.resolve();
    return Promise.allSettled(
      events.map(e => sendMessage(session.transport, "event_broadcast", e, { msgId: createServerMsgId() }))
    ).catch(() => scheduleSessionCleanup(cid));
  });
  await Promise.allSettled(tasks);
};
```

**Cost for 50 events, 100 subscribers:** 5,000 sequential sends → 100 parallel batches.

---

## The Scalability Architecture (10K+ Connections)

### Layer 1: Single-Server Optimizations (No infra change needed)

All P1-P6 fixes above. Plus:

**Backpressure-aware send queue:**
```js
class SendQueue {
  constructor(ws, { highWatermark = 64 * 1024, maxQueueSize = 1000 } = {}) {
    this.ws = ws;
    this.queue = [];
    this.highWatermark = highWatermark;
    this.maxQueueSize = maxQueueSize;
  }
  
  send(message) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest broadcast messages
      this.queue = this.queue.filter(m => m.type !== "event_broadcast");
    }
    this.ws.send(JSON.stringify(message));
  }
}
```

**Connection limits and rejection:**
```js
const MAX_CONNECTIONS = 10_000;

attachConnection: (transport) => {
  if (sessions.size >= MAX_CONNECTIONS) {
    sendError(transport, "server_busy", "Maximum connections reached");
    transport.close("server_busy");
    return null;
  }
  // ... normal flow
}
```

**Expected single-server capacity after fixes:** 5K-10K concurrent connections, 10K+ events/sec.

---

### Layer 2: Multi-Process via Redis Pub/Sub

When one server isn't enough:

```js
// Broadcast bus interface
interface BroadcastBus {
  publish(channel: string, event: CommittedEvent): Promise<void>;
  subscribe(channel: string, handler: (event: CommittedEvent) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

// Redis implementation
class RedisBroadcastBus {
  constructor(redisClient) {
    this.sub = redisClient.duplicate();
    this.handlers = new Map();
    this.sub.on("message", (channel, data) => {
      const event = JSON.parse(data);
      this.handlers.get(channel)?.forEach(h => h(event));
    });
  }
  
  async publish(projectId, event) {
    await this.redis.publish(`insieme:project:${projectId}`, JSON.stringify(event));
  }
  
  async subscribe(projectId, handler) {
    const key = `insieme:project:${projectId}`;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
      await this.sub.subscribe(key);
    }
    this.handlers.get(key).add(handler);
  }
}
```

**How it changes the server:**
```js
// On connect:
await bus.subscribe(projectId, (event) => {
  // Send to this session
  sendMessage(session.transport, "event_broadcast", event).catch(() => cleanup());
});

// On commit:
await bus.publish(projectId, committedEvent);
// No more local broadcast loop needed
```

**This eliminates P1 (O(n) scan) entirely — Redis handles fanout.**

---

### Layer 3: Store Sharding

When SQLite/LibSQL throughput becomes the bottleneck:

```js
// Per-project database files (SQLite)
function getStoreForProject(projectId) {
  const hash = hashProjectId(projectId);
  const shardIndex = hash % NUM_SHARDS;
  return shardStores[shardIndex];
}

// Or: per-project LibSQL namespaces
// Or: PostgreSQL with project-level partitioning
```

---

## The Robustness Hardening Checklist

### Session Lifecycle

| Issue | Current | Fix |
|---|---|---|
| Session state machine | 3 string states + booleans | Formal FSM: `await_connect → active → closing → closed` |
| `syncInProgress` race | Boolean flag, no mutex | Queue sync requests, reject overlapping |
| `syncInProgress` stuck on error | Never reset in error path | Reset in finally block |
| Double-close crash | `closeSession` can throw | Wrap in try/catch, guard with `state === 'closed'` |
| Unhandled rejection | receiveQueue pattern | Terminal `.catch()` + per-operation try/catch |

### Error Handling

| Issue | Fix |
|---|---|
| Store error kills batch | Convert to rejected results, don't re-throw |
| Broadcast error cascades | `Promise.allSettled` per recipient |
| `sendError` itself throws | Wrap in try/catch everywhere |
| JSON parse in bridge | Already handled ✓ |

### Graceful Shutdown

```js
// In order:
1. Stop accepting new connections (detach from ws server)
2. Set `shuttingDown = true`, reject new messages with "server_shutting_down"
3. Wait for in-flight commits to complete (drain)
4. Send "server_shutdown" to all connected clients
5. Close all WebSocket connections cleanly
6. Close store connections
```

### Store Robustness

| Issue | Fix |
|---|---|
| LibSQL: no transaction in commit | Wrap INSERT + dedup in transaction |
| LibSQL: init race condition | Mutex on `ensureInitialized` |
| SQLite: init race | Same mutex pattern |
| Payload deserialization failure | Catch and return null entry, don't crash sync response |

---

## Implementation Order

### Phase 1: Fix Fatal Bugs (1-2 days)
1. **F1** — Broadcast isolation with `Promise.allSettled`
2. **F2** — Store errors become rejected results
3. **F3** — Graceful shutdown with drain
4. **F4** — receiveQueue terminal catch

### Phase 2: Performance Criticals (3-5 days)
1. **P1** — Per-project session index
2. **P2** — Batch commit (new `commitBatch` store method)
3. **P3** — WebSocket backpressure
4. **P4** — Pre-loop authorization check
5. **P6** — Batch broadcast

### Phase 3: Robustness Hardening (2-3 days)
1. Session FSM
2. LibSQL transaction wrapping
3. Init mutex for stores
4. Connection limits + rejection

### Phase 4: Scalability Architecture (5-10 days)
1. Broadcast bus abstraction
2. Redis Pub/Sub implementation
3. Store sharding
4. Multi-process deployment template

### Phase 5: Observability (2-3 days)
1. Structured metrics (events/sec, broadcast latency, queue depth, memory)
2. Health check endpoint (`/health`)
3. Prometheus-compatible metrics endpoint
4. Slow-client detection and logging

---

## Expected Impact

| Metric | Before | After Phase 2 | After Phase 4 |
|---|---|---|---|
| Events/sec (single server) | ~200-500 | ~5,000-10,000 | ~10,000-20,000 |
| Max concurrent connections | ~500 | ~5,000-10,000 | 50,000+ (multi-server) |
| Broadcast latency (100 subscribers) | ~500ms | ~10ms | ~5ms (Redis) |
| Batch commit (50 events) | ~250ms | ~5ms | ~5ms |
| Memory per 10K connections | Unbounded | ~200MB bounded | ~200MB per server |
| Data loss on server crash | In-flight events lost | Zero in-flight loss | Zero in-flight loss |
| Broadcast cascade failures | Yes | No | No |
| Graceful shutdown | No | Yes | Yes |

---

## Files to Modify

| File | Changes |
|---|---|
| `src/sync-server.js` | P1 (project index), P4 (pre-loop authz), P6 (batch broadcast), F1-F4, shutdown, FSM |
| `src/ws-server-bridge.js` | P3 (backpressure), F4 (error handling) |
| `src/ws-server-runtime.js` | Connection limits, shutdown coordination |
| `src/sqlite-sync-store.js` | P2 (batch commit), init mutex |
| `src/libsql-sync-store.js` | P2 (batch commit), transaction wrapping, init mutex |
| `src/in-memory-sync-store.js` | P2 (batch commit), bounded growth (optional) |

### New files

| File | Purpose |
|---|---|
| `src/broadcast-bus.js` | Broadcast bus interface |
| `src/redis-broadcast-bus.js` | Redis Pub/Sub implementation |
| `src/session-fsm.js` | Formal session state machine |
| `src/send-queue.js` | Backpressure-aware WebSocket send queue |
| `src/server-metrics.js` | Structured metrics collection |
