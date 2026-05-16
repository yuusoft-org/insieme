# Backend Robustness Deep-Dive

**Scope:** `sync-server.js`, `ws-server-bridge.js`, `ws-server-runtime.js`, `sqlite-sync-store.js`, `libsql-sync-store.js`, `in-memory-sync-store.js`, `libsql-driver.js`, `payload-codec.js`, `store-errors.js`

**Date:** 2026-05-08

---

## Executive Summary

The Insieme server has a **mature baseline** — the `receiveQueue` pattern prevents per-connection message reordering, the `closeSession` idempotency guard prevents double-close crashes, and store commits use proper transactions with idempotent `commitOrGetExisting`. However, the analysis surfaces **16 distinct robustness issues** across 6 categories: 4 critical, 7 high, 5 medium. The most consequential are: broadcast failures can cascade across all subscribers; store errors during batch commit silently drop events without telling the client which ones failed; there is no graceful shutdown mechanism for in-flight operations; and multiple unhandled-promise-rejection paths exist.

---

## 1. Store Commit Failure — Data Loss & Partial Acknowledgment

**Files:** `sync-server.js:691–730`, `sqlite-sync-store.js`, `libsql-sync-store.js`

### Finding 1.1 — Store Error Re-throws Kill the Entire Batch (CRITICAL)

```js
// sync-server.js:712-729
} catch (err) {
  const code = isObject(err) && typeof err.code === "string" ? err.code : null;
  if (code === "validation_failed" || code === "forbidden") {
    pushRejected(item.id, ...);
    continue;
  }
  throw err;  // ← bubbles up to handleMessage's catch block
}
```

When the store throws an unexpected error (e.g., SQLITE_BUSY timeout, disk full, connection lost), the error is **re-thrown**. This causes:

1. The **entire `handleSubmit` function aborts** — no `submit_events_result` message is sent to the client.
2. The client never learns the fate of **any** event in the batch (including events already successfully committed before the failure).
3. Events already committed to the store before the error are **permanently in the store** but the client doesn't know. If the client retries the whole batch, already-committed events hit the dedup path (`commitOrGetExisting`), so there's no duplication — but the client can't distinguish "committed" from "maybe committed" vs "definitely lost".
4. The error propagates to `handleMessage` → `receiveQueue`, which catches it, sends a generic `"server_error"`, and closes the session. **The client loses the entire connection** over a single transient store error on one event.

**Impact:** Data is not lost (store writes survive), but the client has **no way to know** which events committed. The session termination is disproportionate.

**Recommendation:** Catch store errors per-item, mark remaining events as `"not_processed"` (like the `blockedById` pattern already used), send the `submit_events_result`, then optionally close the session. Alternatively, add an `"internal_error"` status to the result schema.

### Finding 1.2 — Libsql Store Race in `commitOrGetExisting` (HIGH)

```js
// libsql-sync-store.js:229-283
const insertResult = await db.execute(
  `INSERT INTO committed_events(...) VALUES (..., ?, ...) ON CONFLICT(id) DO NOTHING`,
  [...]
);
const insertedOrExisting = await getById(id);
if (db.rowsAffected(insertResult) === 0) {
  if (toComparisonKey(parsed) !== comparisonKey) {
    error.code = "validation_failed";
    throw error;
  }
  return { deduped: true, committedEvent: parsed };
}
```

The libsql store performs INSERT + separate SELECT without a transaction wrapper. Between the INSERT and the `getById` SELECT, another concurrent connection could:
- Insert the same ID with different content, making `getById` return the wrong row.
- In theory, the `ON CONFLICT(id) DO NOTHING` + `UNIQUE` constraint prevents the duplicate insert, but the two statements are **not atomic** without a transaction.

Compare with `sqlite-sync-store.js` which correctly wraps this in `createTransaction(db, fn)` (line 253) — a `BEGIN IMMEDIATE` transaction that holds the write lock for the entire check-and-insert.

**Impact:** Under concurrent writes, two clients submitting the same ID with different payloads could both pass the check, or the comparison could return incorrect results. In practice, the `UNIQUE` constraint on `id` prevents data corruption, but the error message/code could be wrong.

**Recommendation:** Wrap the libsql `commitOrGetExisting` in a transaction, or use a single SQL statement with `RETURNING`.

### Finding 1.3 — `deserializePayload` Can Throw on Corrupt Data (MEDIUM)

```js
// payload-codec.js:80
return JSON.parse(decoder.decode(toUint8Array(value)));
```

If the stored payload blob is corrupted (partial write, encoding mismatch), `JSON.parse` will throw. This exception is not caught in `parseCommittedRow` → `listCommittedSince`. A single corrupt row will **abort the entire sync response**, closing the session.

**Impact:** One corrupted event makes the project unsyncable for all clients.

**Recommendation:** Wrap `deserializePayload` in a try-catch, returning a sentinel value or skipping the corrupted row with a log warning.

---

## 2. Broadcast Failures — Cascade Risk

**File:** `sync-server.js:425–447`

### Finding 2.1 — Sequential Broadcast, No Per-Recipient Error Isolation (CRITICAL)

```js
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipients = [...sessions.values()].filter(...);

  for (const session of recipients) {
    await sendMessage(session.transport, "event_broadcast", committedEvent, {...});
  }
};
```

The broadcast loop is **sequential** with `await`. If `sendMessage` throws for one recipient (e.g., `transport.send` rejects), the error propagates up through `handleSubmit` → `receiveQueue`, which:
1. Sends `"server_error"` to the **submitting client** (not the failing recipient).
2. **Closes the submitting client's session**.
3. Remaining recipients never receive the broadcast at all.

**Impact:** A single dead/failing WebSocket kills the submitter's connection and prevents all other subscribers from receiving the event.

**Recommendation:** Wrap each `sendMessage` in try-catch. Log failures per-recipient. Continue broadcasting to remaining clients. Consider using `Promise.allSettled` for parallel sends.

### Finding 2.2 — Broadcast Reads Stale Session State (MEDIUM)

```js
const recipients = [...sessions.values()].filter(
  (session) =>
    session.state === "active" &&
    session.transport.connectionId !== originConnectionId &&
    !session.syncInProgress &&
    session.activeProjectId === committedEvent.projectId,
);
```

The recipient list is snapshot-based. During the sequential `await` loop, sessions can change state:
- A session could transition to `"closed"` between being added to `recipients` and the `sendMessage` call.
- A session could start a sync (`syncInProgress = true`), meaning it should have been excluded.

The `transport.send` in the bridge checks `ws.readyState !== ws.OPEN` (line 52 of bridge), which provides a safety net for truly dead sockets. But logical state inconsistencies (sending to a closed-but-not-yet-cleaned session) could cause unexpected errors.

**Impact:** Low — the bridge's `readyState` check is the real guard. But it's sloppy.

---

## 3. Race Conditions in Session State

**File:** `sync-server.js`

### Finding 3.1 — `syncInProgress` Boolean Flag, No Mutex (HIGH)

```js
// sync-server.js:823
session.syncInProgress = true;
// ... await store operations ...
// sync-server.js:870
session.syncInProgress = false;
```

The `receiveQueue` ensures messages are processed **sequentially per connection**, but `syncInProgress` is read by `broadcastCommitted` which runs on a **different connection's** receive queue. There is no synchronization primitive protecting this flag.

**Scenario:** Connection A is syncing. Connection B submits an event. The broadcast filter checks `!session.syncInProgress` for Connection A. This read races with Connection A's sync completion. Under Node.js's single-threaded model, this is safe because the flag is only mutated during `await` boundaries, and the broadcast loop runs synchronously between awaits. However, if the broadcast is made concurrent (per recommendation 2.1), this becomes a real data race.

**Impact:** Currently safe under Node.js's cooperative concurrency model, but fragile under future parallelization.

**Recommendation:** Document the single-threaded assumption explicitly, or use an atomic counter/lock pattern.

### Finding 3.2 — `handleSync` Doesn't Clear `syncInProgress` on Error (HIGH)

```js
// sync-server.js:750-873
const handleSync = async (session, payload, context = {}) => {
  // ... validation ...
  session.syncInProgress = true;  // line 823

  const page = await store.listCommittedSince({...});  // can throw

  await sendMessage(...);  // can throw

  if (!page.hasMore) {
    session.syncInProgress = false;      // line 870 — only reached on success
    session.syncToCommittedId = null;    // line 871
  }
};
```

If `store.listCommittedSince` or `sendMessage` throws, `syncInProgress` is **never reset** to `false`. The error is caught by the `receiveQueue`'s catch block, which closes the session. But if the session survives (e.g., if error handling is later changed to be more lenient), the session is permanently stuck: broadcasts will always skip it (`!session.syncInProgress` is `false`), and subsequent sync requests may behave incorrectly.

**Impact:** Currently mitigated because the session is closed on error. But the cleanup is implicit, not guaranteed.

**Recommendation:** Add a `finally` block:
```js
try {
  // ... sync logic ...
} finally {
  session.syncInProgress = false;
  session.syncToCommittedId = null;
}
```

### Finding 3.3 — `ensureInitialized` in SQLite Store Is Not Concurrency-Safe (MEDIUM)

```js
// sqlite-sync-store.js:320-326
const ensureInitialized = () => {
  if (initialized) return;
  runPragmas();
  initializeSchema();
  prepareStatements();
  initialized = true;
};
```

If two concurrent requests call `commitOrGetExisting` simultaneously on a fresh store, both see `initialized === false`, both run `initializeSchema()`, and both call `prepareStatements()`. The second call overwrites the prepared statement references, leaking the first set. In SQLite, `better-sqlite3`'s `.prepare()` is synchronous, so this is actually safe from data corruption, but it's wasteful and the `initialized` flag is set twice.

The libsql store handles this correctly with an `initPromise` memo (line 61, 185-198).

**Impact:** Low — functional correctness is preserved, but minor resource waste.

---

## 4. The `receiveQueue` Pattern — Unhandled Rejections & Reordering

**File:** `sync-server.js:1006–1034`

### Finding 4.1 — `receiveQueue` Silently Swallows Errors (HIGH)

```js
receiveQueue = receiveQueue
  .catch(() => {})          // ← swallows the previous error
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch {
      // sends error, closes session
    }
  });
return receiveQueue;
```

The `.catch(() => {})` on line 1009 **silently discards** any rejection from the previous message handler. This means:
1. If the previous handler rejected (which shouldn't happen given the inner try-catch, but could if `sendError` itself throws), the rejection is lost.
2. The next message proceeds regardless, even if the previous message left the session in an inconsistent state.

This is actually **correct behavior for the intended purpose** — ensuring the queue doesn't stall on errors. But it means `receiveQueue` is not a reliable error signal. The `return receiveQueue` on line 1033 returns a promise that the caller (the bridge's `onMessage`) never awaits for its rejection.

**Impact:** The inner try-catch handles errors, so this is defensive. But if `sendError` or `closeSession` throws inside the catch block, the rejection is silently swallowed.

**Recommendation:** Add error logging inside the `.catch(() => {})`:
```js
.catch((err) => { log({ event: "receive_queue_error", error: String(err) }); })
```

### Finding 4.2 — `closeSession` Can Throw, Leaving Session in Map (HIGH)

```js
// sync-server.js:206-217
const closeSession = async (connectionId, reason) => {
  const session = sessions.get(connectionId);
  if (!session) return;
  session.state = "closed";
  sessions.delete(connectionId);
  await session.transport.close(undefined, reason);  // ← can throw
};
```

If `transport.close()` throws, the session is already deleted from the map and marked `"closed"`, so functional impact is minimal. But the rejection propagates to the caller. In `broadcastCommitted` (which calls `closeSession` indirectly through `handleMessage`'s catch), this could cause the broadcast cascade described in finding 2.1.

The bridge's `close` method (ws-server-bridge.js:56-64) does `ws.close()` inside a try-catch, so `transport.close` should not throw. But if the `ws` library emits an error synchronously on `.close()`, or if a custom transport implementation doesn't protect against this, the exception propagates.

**Impact:** The session is cleaned up from the map even if `transport.close` throws, so no memory leak. But the caller gets an unhandled rejection.

### Finding 4.3 — Unhandled Rejection from `receiveQueue` Promise Chain (HIGH)

```js
// sync-server.js:1008-1033
receiveQueue = receiveQueue
  .catch(() => {})
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch {
      await sendError(...);
      await closeSession(...);
    }
  });
return receiveQueue;
```

If `sendError` throws inside the catch block (e.g., transport is already dead), then:
1. `closeSession` is never called (it's after `sendError`).
2. The rejection propagates up through `.then()`.
3. Since nobody `.catch()`s the returned `receiveQueue` in the bridge...

Wait — let's check the bridge:

```js
// ws-server-bridge.js:106
await session.receive(parsed);
```

The bridge **does** `await` the return value. But the `onMessage` handler itself is `async` and called by the `ws` library's event emitter, which doesn't handle rejected promises. So the rejection from `sendError` failure would become an **unhandled promise rejection** at the process level.

**Impact:** In Node.js, unhandled promise rejections can crash the process (depending on the `--unhandled-rejections` flag). At minimum, they generate warnings.

**Recommendation:** The bridge's `onMessage` catch block (line 107-112) catches errors from `await session.receive(parsed)`, so this is actually handled. But if the error is thrown asynchronously (i.e., `receiveQueue` settles after `onMessage` returns because the previous message's promise hasn't settled yet), then the rejection is truly unhandled.

Specifically: `receiveQueue` chains onto the **previous** message's promise. If the previous message is still processing, `receiveQueue` won't settle until that's done. By that time, `onMessage`'s `await` is already done (it returned the previous `receiveQueue` promise). The **new** `receiveQueue` promise is not awaited by anyone.

This is a genuine unhandled rejection path. If message N's handler throws and `sendError` also fails, the rejection from message N's `receiveQueue` promise is never caught.

---

## 5. Memory & Resource Leaks

### Finding 5.1 — `keepAliveTimer` Not Cleared on `onMessage` Error Path (MEDIUM)

```js
// ws-server-bridge.js:96-113
const onMessage = async (raw) => {
  try {
    const parsed = JSON.parse(text);
    await session.receive(parsed);
  } catch (error) {
    log("invalid_message", {...});
    ws.close(1003, "invalid_message");
    // ← keepAliveTimer is NOT cleared here
  }
};
```

When a message fails to parse or `session.receive` throws (caught by the outer catch), `ws.close(1003)` is called. This triggers the `ws` library's `"close"` event, which fires `onClose`, which calls `maybeClearInterval(keepAliveTimer)`. So the timer **is** eventually cleared when the close event fires.

However, if `ws.close()` doesn't immediately trigger the close event (e.g., the close handshake stalls), the keepalive timer continues running, pinging a socket that's supposed to be dead. This is minor — the timer checks `if (closed) return` (line 76), but `closed` is only set in `onClose` or the bridge's `close` method, not in `onMessage`'s error path.

**Impact:** Minor — the timer will be cleaned up when the close event fires. But there's a window where the timer pings a dying socket.

### Finding 5.2 — `bridges` Map in Runtime Grows if `ws.close` Event Never Fires (LOW)

```js
// ws-server-runtime.js:57-64
ws.on("close", () => {
  bridges.delete(bridge.connectionId);
  activeConnections = Math.max(0, activeConnections - 1);
});
```

The bridge cleanup in the runtime depends on the `ws` `"close"` event. If the underlying socket is terminated abnormally without the `close` event firing (e.g., `ws.terminate()` is called by the keepalive check), the bridge entry stays in the map forever.

The `ws` library's `terminate()` method does emit a `"close"` event, so this should be fine. But if a custom WebSocket implementation is used, this could leak.

**Impact:** Low with the `ws` library. Medium with custom implementations.

### Finding 5.3 — In-Memory Store Grows Unbounded (LOW by design)

The `in-memory-sync-store.js` never evicts committed events. The `committed` array and `byId` map grow forever. This is by design (it's an in-memory store for testing), but worth noting if it's ever used in production.

---

## 6. Graceful Shutdown

**File:** `sync-server.js:1040-1045`

### Finding 6.1 — `shutdown()` Doesn't Wait for In-Flight Operations (CRITICAL)

```js
shutdown: async () => {
  const ids = [...sessions.keys()];
  for (const connectionId of ids) {
    await closeSession(connectionId, "shutdown");
  }
},
```

`shutdown` iterates all sessions and closes them. But:

1. **In-flight `handleSubmit` calls:** If a session is currently in the middle of `handleSubmit` (processing events, committing to the store, broadcasting), `closeSession` sets `session.state = "closed"` and calls `transport.close()`. However, the `receiveQueue`'s current execution continues — it doesn't check `session.state` mid-execution. The store commit may succeed, but the `sendMessage` to the client will silently fail (bridge checks `readyState`), and the broadcast to other clients will proceed for an already-closed session.

2. **Broadcast race:** `closeSession` is called sequentially. While Connection A is being closed, Connection B's in-flight `handleSubmit` may still be broadcasting to Connection A (which is now closed).

3. **No drain signal:** There's no mechanism to signal "stop accepting new messages" while allowing in-flight operations to complete. The server goes from fully operational to killing all sessions immediately.

**Impact:** On shutdown, events that were committed to the store may have their broadcasts lost. Clients that reconnect to a new server instance will eventually get the events via sync, but there's a window of inconsistency.

**Recommendation:**
- Add a `draining` flag that rejects new messages.
- Wait for all `receiveQueue` promises to settle before closing sessions.
- Use `Promise.allSettled` for parallel session closure.

### Finding 6.2 — Runtime `closeAllConnections` vs `shutdown` Disconnect (HIGH)

```js
// ws-server-runtime.js:71-78
closeAllConnections: async (reason = "server_close") => {
  const closing = [...bridges.values()].map((bridge) => bridge.close(reason));
  await Promise.allSettled(closing);
  bridges.clear();
  activeConnections = 0;
},
```

The runtime's `closeAllConnections` closes connections at the WebSocket level, but it **doesn't call `syncServer.shutdown()`**. This means:
- The `sessions` map inside `syncServer` retains entries for closed connections.
- If `syncServer.shutdown()` is called later, it tries to close already-closed sessions (which is harmless due to the `if (!session) return` guard).

Conversely, if `syncServer.shutdown()` is called without `closeAllConnections()`, the WebSocket sockets are closed (via `transport.close`), but the runtime's `bridges` map and `activeConnections` counter aren't updated until the `ws` `"close"` events fire.

There's no unified shutdown orchestrator.

**Impact:** Double-close is safe, but confusing. No data loss, but potential for unclean shutdown ordering.

---

## 7. JSON Parsing in the Bridge

**File:** `ws-server-bridge.js:96-113`

### Finding 7.1 — JSON.parse Failure Is Handled Correctly (POSITIVE)

```js
const onMessage = async (raw) => {
  try {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const parsed = JSON.parse(text);
    await session.receive(parsed);
  } catch (error) {
    log("invalid_message", {...});
    ws.close(1003, "invalid_message");
  }
};
```

`JSON.parse` failures are correctly caught, logged, and the connection is closed with code 1003 (unsupported data). This is well-handled.

**Caveat:** If `raw` is a non-string, non-Buffer `ArrayBuffer` or `DataView`, `String(raw)` produces `[object ArrayBuffer]` or `[object DataView]`, which will fail JSON.parse. This is arguably correct behavior (reject invalid data).

---

## 8. Auth Token Verification — Blocking Concern

**File:** `sync-server.js:359-371`

### Finding 8.1 — Slow `verifyToken` Blocks Other Messages on Same Connection (MEDIUM)

```js
let identity;
try {
  identity = await auth.verifyToken(token);
} catch { ... }
```

Since each connection has its own `receiveQueue`, a slow `verifyToken` only blocks messages on **that specific connection**. Other connections process messages independently.

However, during the `connect` phase, if `verifyToken` takes 5 seconds (e.g., remote JWT validation, database lookup), the connection's `receiveQueue` is blocked. If the client sends additional messages during this window, they queue up and are processed after the connect completes — but the session is still in `"await_connect"` state, so non-connect messages are rejected.

**Impact:** Per-connection only. Acceptable for most deployments. If auth becomes a bottleneck, the architecture supports per-connection isolation.

**Recommendation:** Document the expected latency characteristics of `verifyToken`. Consider adding a connect timeout.

### Finding 8.2 — `authz.authorizeProject` Called Twice per Submit (LOW)

```js
// sync-server.js:386 — during connect
const authorized = await authz.authorizeProject(identity, projectId);

// sync-server.js:652 — during every submit
const authorized = await authz.authorizeProject(session.identity, item.projectId);
```

Authorization is checked at connect time and again on every submitted event. This is a defense-in-depth pattern (permissions may have changed), but it means every submit event incurs an authorization check. If `authorizeProject` is slow (e.g., database query), this is amplified by batch size.

**Impact:** Performance concern, not a correctness issue.

---

## 9. Uncaught Async Errors

### Finding 9.1 — `handleConnect` Can Leave Session in Inconsistent State (HIGH)

```js
// sync-server.js:399-422
session.state = "active";           // line 399
session.identity = identity;        // line 400
session.activeProjectId = projectId; // line 401

const maxCommittedId = await store.getMaxCommittedIdForProject({...});  // line 410
await sendMessage(session.transport, "connected", {...});              // line 413
```

If `store.getMaxCommittedIdForProject` throws after the session is already set to `"active"`, the session is in an inconsistent state: it's marked active but the client never received the `"connected"` message. The error propagates to `handleMessage`'s catch block, which sends `"server_error"` and closes the session. So the session is cleaned up — but the state transition to `"active"` was premature.

**Impact:** Session is closed, so no lasting damage. But the early state transition is a code smell.

**Recommendation:** Move the state update after the `sendMessage` call, or use a two-phase approach.

### Finding 9.2 — `sendError` Itself Can Throw (MEDIUM)

Multiple places call `sendError` inside catch blocks:
```js
try {
  await handleMessage(session, message);
} catch {
  await sendError(...);     // ← can throw if transport is dead
  await closeSession(...);  // ← never reached if sendError throws
}
```

If `sendError` throws (because `transport.send` fails), `closeSession` is never called. The rejection propagates up through the `receiveQueue` chain, becoming an unhandled rejection (see finding 4.3).

**Recommendation:** Make error reporting best-effort:
```js
try { await sendError(...); } catch { /* best effort */ }
await closeSession(...);
```

---

## 10. Summary of Findings

| # | Severity | Category | Finding | File:Line |
|---|----------|----------|---------|-----------|
| 1.1 | 🔴 CRITICAL | Data Integrity | Store error kills batch, no result sent | sync-server.js:729 |
| 2.1 | 🔴 CRITICAL | Resilience | Broadcast failure cascades to all recipients | sync-server.js:434-446 |
| 6.1 | 🔴 CRITICAL | Graceful Shutdown | No drain/wait for in-flight operations | sync-server.js:1040-1045 |
| 4.3 | 🔴 CRITICAL | Unhandled Rejection | receiveQueue rejection unhandled when sendError fails | sync-server.js:1008-1033 |
| 1.2 | 🟡 HIGH | Data Integrity | Libsql commit not wrapped in transaction | libsql-sync-store.js:229-283 |
| 3.2 | 🟡 HIGH | Race Condition | syncInProgress not reset on error | sync-server.js:823-872 |
| 4.1 | 🟡 HIGH | Error Handling | receiveQueue silently swallows errors | sync-server.js:1009 |
| 4.2 | 🟡 HIGH | Error Handling | closeSession can throw, leaving unhandled rejection | sync-server.js:211 |
| 6.2 | 🟡 HIGH | Graceful Shutdown | No unified shutdown orchestrator | ws-server-runtime.js:71-84 |
| 9.1 | 🟡 HIGH | State Management | handleConnect sets active before response sent | sync-server.js:399-422 |
| 9.2 | 🟡 HIGH | Error Handling | sendError in catch blocks can prevent closeSession | sync-server.js:1018-1030 |
| 1.3 | 🟠 MEDIUM | Data Integrity | Corrupt payload blob aborts entire sync | payload-codec.js:80 |
| 2.2 | 🟠 MEDIUM | Race Condition | Broadcast reads stale session state | sync-server.js:426-432 |
| 3.3 | 🟠 MEDIUM | Concurrency | SQLite ensureInitialized not concurrency-safe | sqlite-sync-store.js:320-326 |
| 5.1 | 🟠 MEDIUM | Resource Leak | keepAliveTimer window on error path | ws-server-bridge.js:107-112 |
| 8.1 | 🟠 MEDIUM | Performance | Slow verifyToken blocks connection | sync-server.js:360 |

---

## 11. Recommendations Summary

### Immediate (addresses critical issues)

1. **Isolate broadcast failures** — wrap each `sendMessage` in `broadcastCommitted` with try-catch; use `Promise.allSettled` for parallel sends.
2. **Handle store errors per-event in `handleSubmit`** — catch all store errors, push remaining events as `"not_processed"`, always send `submit_events_result`.
3. **Fix the receiveQueue unhandled rejection** — add a `.catch()` to the chain, or make `sendError` + `closeSession` in the catch block individually wrapped in try-catch.
4. **Add graceful drain to shutdown** — signal "draining", wait for all receiveQueue promises to settle, then close sessions.

### Short-term (addresses high issues)

5. Wrap libsql `commitOrGetExisting` in a transaction.
6. Add `finally` block to `handleSync` to clear `syncInProgress`.
7. Log receiveQueue errors instead of silently swallowing them.
8. Move session state transition in `handleConnect` after successful response.
9. Create a unified shutdown orchestrator that coordinates runtime and sync server.

### Long-term (hardening)

10. Add per-connection connect timeout to prevent slow auth from stalling.
11. Handle corrupt payload blobs gracefully in `listCommittedSince`.
12. Document the single-threaded concurrency assumptions for session state flags.
13. Consider an atomic/lock pattern for `syncInProgress` if broadcasts are parallelized.
