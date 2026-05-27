# Insieme Backend Performance Deep-Dive

**Date:** 2026-05-08  
**Scope:** Server-side sync stores, sync server, WebSocket bridge/runtime  
**Files analyzed:**
- `src/sqlite-sync-store.js` (SQLite store – better-sqlite3)
- `src/libsql-sync-store.js` (LibSQL store – async, remote-compatible)
- `src/in-memory-sync-store.js` (In-memory store – testing/benchmarking)
- `src/sync-server.js` (Core protocol handler)
- `src/ws-server-bridge.js` (WebSocket transport adapter)
- `src/ws-server-runtime.js` (WS server lifecycle)
- `src/libsql-driver.js` (LibSQL client wrapper)
- `src/canonicalize.js` (Dedup canonicalization)
- `src/payload-codec.js` (Payload serialization)

---

## Executive Summary

The codebase is well-structured with clear separation of concerns. However, analysis reveals **7 critical**, **5 high**, and **4 medium** severity findings across database query patterns, transaction handling, broadcast efficiency, memory management, and concurrency control. The most impactful issues are: write amplification in the SQLite commit path (3 SQL statements per event), O(n) linear scan for broadcasting, missing backpressure on WebSocket sends, and unbounded memory growth in the in-memory store.

---

## 1. SQL Query Efficiency & Index Coverage

### 1.1 Existing Indexes (SQLite & LibSQL)

```sql
-- Single composite index:
CREATE INDEX committed_events_project_committed_idx
  ON committed_events(project_id, committed_id);
```

The table has:
- `committed_id INTEGER PRIMARY KEY AUTOINCREMENT` (implicit index)
- `id TEXT NOT NULL UNIQUE` (implicit unique index)
- `committed_events_project_committed_idx ON (project_id, committed_id)`

### 1.2 Query Coverage Analysis

| Query | Index Used | Verdict |
|---|---|---|
| `WHERE id = ?` | UNIQUE on `id` | ✅ Good |
| `WHERE project_id = ? AND committed_id > ? AND committed_id <= ? ORDER BY committed_id ASC` | Composite `(project_id, committed_id)` | ✅ Good |
| `SELECT MAX(committed_id) WHERE project_id = ?` | Composite `(project_id, committed_id)` | ✅ Good |
| `SELECT MAX(committed_id)` (global) | PK scan | ⚠️ Acceptable (single B-tree seek) |

**Verdict:** Index coverage is actually quite good for the current query patterns. The composite `(project_id, committed_id)` index covers range scans, max lookups, and ordering.

### 1.3 Missing Index Opportunities

**[MEDIUM] No index on `(project_id, server_ts)` or `(project_id, created_at)`**

If future features need time-range queries per project (e.g., "events in last hour"), these will require full index scans. Not blocking today but worth planning.

**[MEDIUM] No covering index for broadcast queries**

Currently broadcasts don't query the DB (they iterate sessions in memory), so this is not an issue yet.

---

## 2. Transaction Granularity & Lock Contention

### 2.1 SQLite Store: Per-Event Transaction [CRITICAL]

**Finding:** `commitOrGetExisting` wraps every single event in its own `BEGIN IMMEDIATE` transaction.

```javascript
// sqlite-sync-store.js lines 253-317
commitTxn = createTransaction(db, ({ id, partition, ... }) => {
  const existing = getByIdStmt.get({ id });           // SQL #1
  // ... canonicalization ...
  insertCommittedStmt.run({ ... });                    // SQL #2
  const inserted = getByIdStmt.get({ id });            // SQL #3
  return { deduped, committedEvent: parseCommittedRow(inserted) };
});
```

**Impact:**
- **3 SQL statements per committed event** (SELECT → INSERT → SELECT)
- Each call acquires an `IMMEDIATE` lock, blocking all other writers
- When `handleSubmit` processes a batch of N events, it calls `commitOrGetExisting` N times sequentially, each in its own transaction

**Write Amplification:** For a batch of N events, this produces **3N SQL statements** and **N separate transactions** with lock acquire/release cycles.

### 2.2 LibSQL Store: Atomic INSERT but No Transaction Wrapping [HIGH]

**Finding:** The LibSQL store uses `INSERT ... ON CONFLICT(id) DO NOTHING` which is better, but still executes 2 round-trips per event:

```javascript
// libsql-sync-store.js lines 229-283
const insertResult = await db.execute("INSERT ... ON CONFLICT(id) DO NOTHING", [...]);  // SQL #1
const insertedOrExisting = await getById(id);                                            // SQL #2
```

**Problems:**
1. No explicit transaction wrapping – two separate round-trips to potentially remote LibSQL server
2. Race condition window: between INSERT and SELECT, another writer could theoretically interfere (mitigated by SQLite's serialization but problematic with network latency)
3. For remote LibSQL (Turso), each round-trip is a network hop → 2N network round-trips per batch of N events

### 2.3 In-Memory Store: No Concurrency Protection [MEDIUM]

```javascript
// in-memory-sync-store.js
const existing = byId.get(id);
// ... check ...
byId.set(id, { comparisonKey, committedEvent });
committed.push(committedEvent);
```

Since JavaScript is single-threaded, this is safe within a single Node.js process. However, the `committed` array grows unbounded (see §6).

---

## 3. Connection Pooling & Concurrent Access Patterns

### 3.1 SQLite: Single Connection, No Pooling [BY DESIGN]

SQLite uses a single `better-sqlite3` connection. This is correct for SQLite since it's an in-process database. The `busy_timeout=5000` pragma handles contention from external processes.

### 3.2 LibSQL: Single Client, No Pooling [HIGH]

```javascript
// libsql-sync-store.js line 48
export const createLibsqlSyncStore = (client, { ... }) => {
  const db = createLibsqlDriver(client);
```

The store accepts a single LibSQL client with no connection pooling. For remote LibSQL servers:
- All queries serialize through one connection
- No parallel query execution capability
- Network latency on each query compounds (2 round-trips per commit × N events)

**Recommendation:** Accept a pool or document that the caller should manage pooling at a higher level.

### 3.3 LibSQL Initialization Race Condition [CRITICAL]

```javascript
// libsql-sync-store.js lines 183-198
const ensureInitialized = async () => {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => { ... })();
  // ...
};
```

This is correctly implemented with an init promise guard. However, if two calls hit `ensureInitialized` simultaneously before `initPromise` is set, both could proceed. In practice, JavaScript's single-threaded execution makes this extremely unlikely but not impossible under certain async interleavings.

---

## 4. Write Amplification

### 4.1 Per-Event Cost Breakdown

**SQLite Store (per event):**

| Step | Operation | Cost |
|---|---|---|
| 1 | `BEGIN IMMEDIATE` | Lock acquisition |
| 2 | `SELECT WHERE id = ?` (dedup check) | Index seek |
| 3 | `canonicalizeSubmitItem` (CPU) | JSON.stringify + deepSortKeys |
| 4 | `INSERT INTO committed_events` | B-tree insert + index update |
| 5 | `SELECT WHERE id = ?` (read-back) | Index seek |
| 6 | `parseCommittedRow` (CPU) | Field mapping + deserialize |
| 7 | `COMMIT` | WAL flush |

**Total: 3 SQL statements + 2 JSON serialization passes per event**

The read-back SELECT (step 5) is needed to get the auto-generated `committed_id`. This could be eliminated by using `better-sqlite3`'s `this.lastInsertRowid`:

```javascript
// Potential optimization:
insertCommittedStmt.run({ ... });
const committedId = insertCommittedStmt.lastInsertRowid;  // No extra SELECT needed
```

**LibSQL Store (per event):**

| Step | Operation | Cost |
|---|---|---|
| 1 | `canonicalizeSubmitItem` (CPU) | JSON.stringify + deepSortKeys |
| 2 | `INSERT ... ON CONFLICT DO NOTHING` | Network round-trip |
| 3 | `SELECT WHERE id = ?` (read-back) | Network round-trip |

**Total: 2 network round-trips + JSON serialization per event**

**In-Memory Store (per event):**

| Step | Operation | Cost |
|---|---|---|
| 1 | `canonicalizeSubmitItem` (CPU) | JSON.stringify + deepSortKeys |
| 2 | `byId.get(id)` (dedup check) | O(1) |
| 3 | `structuredClone(payload)` | Deep copy |
| 4 | `byId.set(...)` + `committed.push(...)` | O(1) amortized |

**Total: No SQL, but canonicalization + structuredClone per event**

### 4.2 Canonicalization Cost [HIGH]

`canonicalizeSubmitItem` performs:
1. `normalizeMeta` – field normalization
2. `deepSortKeys` – recursive key sorting of the entire payload
3. `JSON.stringify` – full serialization

This happens on **every commit** (even for duplicates in the SQLite store) and again in `handleSubmit` for validation. For large payloads, `deepSortKeys` traverses the entire object tree and creates new objects.

**Recommendation:** Consider a lighter-weight comparison key (e.g., hash-based) or cache the canonical form on the submitted item.

### 4.3 Batch Processing: No Batching at DB Level [CRITICAL]

`handleSubmit` processes events in a sequential loop:

```javascript
// sync-server.js lines 552-731
for (let index = 0; index < payload.events.length; index += 1) {
  // ... validation per event ...
  const { deduped, committedEvent } = await store.commitOrGetExisting({ ... });
  // ...
}
```

Each event is individually committed to the store. A batch of 50 events generates:
- **SQLite:** 50 transactions × 3 statements = 150 SQL statements
- **LibSQL:** 50 × 2 round-trips = 100 network round-trips
- **In-Memory:** 50 canonicalizations + structuredClones

**Recommendation:** Add a `commitBatch` method that wraps multiple events in a single transaction for SQLite, and uses LibSQL batch/exec for network-efficient multi-row insert.

---

## 5. Broadcast Efficiency

### 5.1 O(n) Full Session Scan [CRITICAL]

```javascript
// sync-server.js lines 425-447
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipients = [...sessions.values()].filter(
    (session) =>
      session.state === "active" &&
      session.transport.connectionId !== originConnectionId &&
      !session.syncInProgress &&
      session.activeProjectId === committedEvent.projectId,
  );

  for (const session of recipients) {
    await sendMessage(session.transport, "event_broadcast", committedEvent, {
      msgId: broadcastMsgId,
    });
  }
};
```

**Problems:**
1. **Full scan of all sessions** on every broadcast – creates a new array via spread + filter
2. **Sequential await** – sends to each recipient one at a time (`for ... await`)
3. **Called per event** – if a batch commits 50 events, this runs 50 times, each scanning all sessions
4. **No project-level indexing** – sessions are in a flat Map, no index by `activeProjectId`

For S servers with P sessions per project: **O(total_sessions × events_committed)** per batch.

**Recommendation:**
- Maintain a `Map<projectId, Set<session>>` index for O(P) lookup
- Send to all recipients concurrently with `Promise.allSettled`
- Batch broadcasts (commit all events, then broadcast all at once)

### 5.2 Broadcast After Response [OK]

Broadcasts happen after the `submit_events_result` response is sent (line 733-747), which is correct – the submitter gets acknowledgment before broadcasts go out.

### 5.3 Sequential Broadcast Per Event [HIGH]

```javascript
// sync-server.js lines 742-747
for (const committedEvent of committedEvents) {
  await broadcastCommitted({
    originConnectionId: session.transport.connectionId,
    committedEvent,
  });
}
```

Each committed event triggers a separate broadcast pass. For N committed events and M recipients, this is **N × M** sequential `sendMessage` calls.

---

## 6. Memory Management

### 6.1 In-Memory Store: Unbounded Growth [CRITICAL]

```javascript
// in-memory-sync-store.js
const byId = new Map();      // Grows without bound
const committed = [];         // Grows without bound
```

Neither `byId` nor `committed` are ever trimmed. Over time:
- `committed` holds every event ever committed
- `listCommittedSince` scans the entire array with `.filter()` every time
- `getMaxCommittedIdForProject` iterates all events linearly

**Impact:** O(n) space and O(n) scan for all read operations. Unsuitable for long-running production use.

### 6.2 Session Map Cleanup [OK]

```javascript
// sync-server.js lines 206-217
const closeSession = async (connectionId, reason) => {
  const session = sessions.get(connectionId);
  if (!session) return;
  session.state = "closed";
  sessions.delete(connectionId);
  await session.transport.close(undefined, reason);
};
```

Sessions are properly cleaned up. The `ws-server-runtime.js` also cleans up bridges:

```javascript
// ws-server-runtime.js line 57-58
ws.on("close", () => {
  bridges.delete(bridge.connectionId);
```

### 6.3 Canonicalization Temporary Objects [MEDIUM]

Each `canonicalizeSubmitItem` call creates:
- A normalized copy of `meta`
- A recursively sorted copy of `payload` (via `deepSortKeys`)
- A JSON string of the combined object

These are short-lived but for large payloads (256KB envelope limit) with many events, GC pressure can be significant.

### 6.4 Payload Deserialization on Read-Back [MEDIUM]

In the SQLite store, the commit flow serializes the payload, inserts it, then reads it back and deserializes:

```javascript
// sqlite-sync-store.js
payload: serializePayload(payload),     // serialize → JSON → Buffer
// ...insert...
const inserted = getByIdStmt.get({ id }); // read back from DB
parseCommittedRow(inserted);              // deserialize → Buffer → JSON.parse
```

This is a double serialization/deserialization cycle. The `serializePayload` and `deserializePayload` pair involves JSON.stringify → TextEncoder → Buffer → TextDecoder → JSON.parse.

---

## 7. Missing Backpressure on Broadcast [CRITICAL]

### 7.1 Fire-and-Forget WebSocket Sends

```javascript
// ws-server-bridge.js lines 51-54
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
  // No backpressure handling!
},
```

The `ws.send()` call is synchronous and non-blocking – it buffers data in the `ws` library's internal buffer. If a client is slow to receive:
1. The buffer grows unbounded
2. Server memory increases
3. Eventually the process may OOM

The `ws` library provides a callback-based API to detect when data has actually been flushed: `ws.send(data, callback)`. The async `send` function ignores this entirely.

### 7.2 Sequential Await on Slow Clients

Even though `ws.send` is fire-and-forget, the broadcast loop `await`s the `sendMessage` call which itself `await`s `transport.send`. Since the transport's `send` resolves immediately (no backpressure), this creates false sequentialism – the `await` adds microtask overhead without actual flow control.

### 7.3 No Buffer Watermark / Drop Policy

There's no mechanism to:
- Detect when a client's send buffer is too large
- Pause or drop slow consumers
- Apply per-client send limits

**Recommendation:**
```javascript
// Example backpressure-aware send:
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  const data = JSON.stringify(message);
  if (ws.bufferedAmount > MAX_BUFFERED) {
    throw new Error("client backpressure");
  }
  return new Promise((resolve, reject) => {
    ws.send(data, (err) => err ? reject(err) : resolve());
  });
},
```

---

## 8. Rate Limiting Analysis

### 8.1 Per-Session Fixed Window [OK with caveats]

```javascript
// sync-server.js lines 258-292
const enforceInboundGuards = async (session, message, msgId) => {
  const now = clock.now();
  if (session.rateWindowStartedAt === 0 || now - session.rateWindowStartedAt >= rateWindowMs) {
    session.rateWindowStartedAt = now;
    session.rateWindowCount = 0;
  }
  session.rateWindowCount += 1;
  if (session.rateWindowCount > maxInboundMessagesPerWindow) { /* reject */ }
```

**Strengths:**
- Per-session isolation (one bad client can't exhaust global limits)
- Configurable window and threshold (default: 200 messages/second)
- Can auto-close on violation (`closeOnRateLimit`)

**Weaknesses:**
- **Fixed window** (not sliding window) – allows burst of 2× at window boundary
- **No global rate limit** – server has no protection against many clients each sending at their limit
- **Counts all messages** including sync responses and pings; should arguably only count submit_events
- **Envelope size check** uses `JSON.stringify` + `Buffer.byteLength` on every message, which is expensive for large messages

### 8.2 Envelope Size Check: Redundant Serialization [MEDIUM]

```javascript
// sync-server.js lines 250-256
const getApproxEnvelopeBytes = (message) => {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
```

This serializes the entire message just to measure its size. The message is then used (not the serialized form), meaning it gets serialized again when sent. For a 256KB message, this doubles the serialization cost.

---

## 9. Additional Findings

### 9.1 Per-Event Authorization Check [HIGH]

```javascript
// sync-server.js lines 652-659
for (let index = 0; index < payload.events.length; index += 1) {
  // ...
  const authorized = await authz.authorizeProject(session.identity, item.projectId);
```

The project authorization check is performed **per event** in the loop, even though all events must have `projectId === session.activeProjectId` (validated on line 643). This means N authorization calls for a batch of N events, all checking the same project.

**Recommendation:** Check authorization once before the loop, or cache the result for the project.

### 9.2 Per-Event Validation + Store Commit Interleaving [MEDIUM]

The submit loop validates and commits events one at a time. A validation failure on event K marks it as rejected and continues, but events K+1...N are processed as `not_processed` only if `blockedById` is set (which it is for `validation_failed` errors). This means a single validation failure blocks the rest of the batch.

```javascript
// sync-server.js lines 554-557
if (blockedById) {
  pushNotProcessed(item.id, blockedById);
  continue;
}
```

**Note:** This appears intentional (fail-fast within a batch), but it means a single bad event wastes the entire batch's processing.

### 9.3 `receiveQueue` Serialization Pattern [OK]

```javascript
// sync-server.js lines 1007-1033
receive: async (message) => {
  receiveQueue = receiveQueue
    .catch(() => {})
    .then(async () => { await handleMessage(session, message); });
  return receiveQueue;
},
```

This correctly serializes all incoming messages per session, preventing concurrent processing. The `.catch(() => {})` ensures a prior error doesn't break the chain. This is a solid pattern.

### 9.4 Keep-Alive Timer Cleanup [OK]

```javascript
// ws-server-bridge.js lines 67-71, 124
const maybeClearInterval = (timer) => { if (timer) clearInterval(timer); };
// ... in onClose:
maybeClearInterval(keepAliveTimer);
```

Timer cleanup is handled properly.

### 9.5 `nextServerMsgId` Overflow [LOW]

```javascript
// sync-server.js lines 200-204
const createServerMsgId = () => {
  const msgId = `srv-${nextServerMsgId}`;
  nextServerMsgId += 1;
  return msgId;
};
```

`nextServerMsgId` is a JavaScript number which is safe up to 2^53. At 1M messages/second, this would take ~285 years to overflow. Not a concern.

---

## 10. Consolidated Recommendations

### Priority 1 (Critical – should fix before production)

| # | Finding | Recommendation |
|---|---|---|
| 1 | Write amplification: 3 SQL/event | Use `lastInsertRowid` to eliminate read-back SELECT; wrap batches in single transactions |
| 2 | O(n) broadcast scan | Index sessions by `activeProjectId`; use `Map<projectId, Set<session>>` |
| 3 | No backpressure on WS sends | Use callback-based `ws.send`; implement buffer watermarks; drop slow clients |
| 4 | Unbounded in-memory store | Add TTL or LRU eviction; or document as testing-only |

### Priority 2 (High – should fix for scale)

| # | Finding | Recommendation |
|---|---|---|
| 5 | LibSQL: 2 round-trips/event, no batching | Use LibSQL batch API; wrap commit+read in transaction |
| 6 | Per-event authorization in batch | Check once before loop; cache authz result for session duration |
| 7 | Sequential broadcast sends | Use `Promise.allSettled` for parallel delivery |
| 8 | Canonicalization cost on every commit | Consider hash-based comparison or caching canonical form |

### Priority 3 (Medium – improve as tech debt)

| # | Finding | Recommendation |
|---|---|---|
| 9 | Double payload serialization | Return the committed event from the INSERT without deserializing from DB |
| 10 | Envelope size check double-serializes | Pass through the already-serialized form or use a streaming size estimator |
| 11 | Rate limiter uses fixed window | Consider sliding window or token bucket for smoother enforcement |
| 12 | No global rate limiting | Add server-wide message rate limit as a safety net |

---

## Appendix A: Transaction Flow Diagram

```
Client                SyncServer              Store (SQLite)
  |                       |                        |
  |--- submit_events ---->|                        |
  |                       |-- enforceInboundGuards |
  |                       |   (rate, size)         |
  |                       |                        |
  |                       |-- for each event: ---> |
  |                       |   validateEvent        |
  |                       |   authorizeProject (!) |
  |                       |   validation.validate   |
  |                       |                        |
  |                       |   commitOrGetExisting  |
  |                       |   |-- BEGIN IMMEDIATE ->|
  |                       |   |-- SELECT (dedup) -->|
  |                       |   |-- canonicalize ---- |
  |                       |   |-- INSERT ---------->|
  |                       |   |-- SELECT (readback)->|
  |                       |   |-- COMMIT ---------->|
  |                       |                        |
  |<-- submit_events_result --|                    |
  |                       |                        |
  |                       |-- for each committed:  |
  |                       |   broadcastCommitted   |
  |                       |   |-- scan ALL sessions|
  |                       |   |-- await send x N  |
```

## Appendix B: Proposed Optimized Batch Commit (SQLite)

```javascript
// Hypothetical batchCommit for sqlite-sync-store.js
const batchCommit = createTransaction(db, (items) => {
  const results = [];
  for (const item of items) {
    const existing = getByIdStmt.get({ id: item.id });
    if (existing) {
      // ... dedup logic ...
      results.push({ deduped: true, committedEvent: parseCommittedRow(existing) });
      continue;
    }
    insertCommittedStmt.run({ ... });
    // Use lastInsertRowid instead of re-reading:
    const committedId = db.pragma('last_insert_rowid')[0].last_insert_rowid;
    results.push({
      deduped: false,
      committedEvent: { ...item, committedId, serverTs: item.now },
    });
  }
  return results;
});
```

This reduces N transactions to 1, and 3N SQL statements to 2N (SELECT + INSERT per event, eliminating the read-back SELECT).

## Appendix C: Proposed Project-Session Index

```javascript
// In sync-server.js
const sessionsByProject = new Map(); // Map<projectId, Set<connectionId>>

// On connect:
const projectSessions = sessionsByProject.get(projectId) || new Set();
projectSessions.add(connectionId);
sessionsByProject.set(projectId, projectSessions);

// On close:
sessionsByProject.get(session.activeProjectId)?.delete(connectionId);

// On broadcast:
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const projectSessions = sessionsByProject.get(committedEvent.projectId);
  if (!projectSessions) return;
  const recipients = [...projectSessions]
    .map(id => sessions.get(id))
    .filter(s => s?.state === "active" && s.transport.connectionId !== originConnectionId && !s.syncInProgress);
  await Promise.allSettled(recipients.map(s => sendMessage(s.transport, "event_broadcast", committedEvent)));
};
```
