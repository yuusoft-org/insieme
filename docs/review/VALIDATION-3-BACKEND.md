# Validation Report: Backend Robustness & Performance Plan

**Validator:** Automated code-level validation  
**Date:** 2026-05-08  
**Plan document:** `BACKEND-ROBUSTNESS-PERFORMANCE-PLAN.md`  
**Source files reviewed:** `sync-server.js` (1047 lines), `ws-server-bridge.js` (155 lines), `ws-server-runtime.js` (85 lines), `sqlite-sync-store.js` (448 lines), `libsql-sync-store.js` (384 lines), `in-memory-sync-store.js` (141 lines), `canonicalize.js` (71 lines)

---

## Executive Summary

Of the 4 fatal bugs claimed, **3 are confirmed as genuine and accurately described** (F1, F2, F3), and **1 is a real concern but partially overstated** (F4). Of the 6 performance killers, **4 are confirmed** (P1, P2, P4, P6), **1 is confirmed but nuanced** (P3), and **1 is partially inaccurate** (P5). Several proposed fixes have correctness issues or miss edge cases. Detailed findings below.

---

## Fatal Bug Validation

### F1. Broadcast failure cascades to all subscribers — ✅ CONFIRMED

**Claim:** `broadcastCommitted` loops through recipients sequentially with `await sendMessage`. If one recipient's send throws, the loop aborts and remaining recipients never get the event. The error propagates up and can kill the submitter's session.

**Actual code (sync-server.js lines 425-447):**
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
    // ...
  }
};
```

**Verification:**
- ✅ The `for...of` loop with `await` on each `sendMessage` IS sequential.
- ✅ If `sendMessage` throws for recipient A, the loop aborts — recipients B, C, D are skipped.
- ✅ `broadcastCommitted` is called from `handleSubmit` at line 742-747 inside the `handleSubmit` function body (not inside a try/catch that swallows the error).
- ⚠️ **Nuance on submitter killing:** The broadcast loop happens AFTER `submit_events_result` is sent (line 733-740 sends the result, then line 742-747 broadcasts). If broadcast throws, the error propagates UP from `handleSubmit` to `handleMessage`'s caller. But `handleSubmit` is called from `handleMessage` (line 968), which is inside the `receiveQueue` chain (line 1016). The catch block at line 1017-1031 would then call `sendError` + `closeSession`, killing the submitter's session.
- ✅ **Line numbers in the plan are slightly off:** Plan says "line 434-446" — actual is lines 434-446. Accurate.

**Verdict:** Bug is real. The submitter's session gets killed because of a broadcast failure to a *different* client.

**Proposed fix evaluation:**
```js
const tasks = recipients
  .filter(s => s.transport.connectionId !== originConnectionId && !s.syncInProgress)
  .map(s =>
    sendMessage(s.transport, "event_broadcast", committedEvent, { msgId: createServerMsgId() })
      .catch(err => {
        log({ event: "broadcast_failed", ... });
        scheduleSessionCleanup(s.transport.connectionId);
      })
  );
await Promise.allSettled(tasks);
```

- ⚠️ **Issue 1:** The filter in the fix re-filters for `connectionId !== originConnectionId` and `!syncInProgress`, but the `recipients` list was already filtered for those conditions. The fix is applying a redundant filter but not wrong.
- ⚠️ **Issue 2:** `scheduleSessionCleanup` is not defined anywhere in the codebase. This is a new abstraction that needs to be implemented. The plan doesn't define it.
- ⚠️ **Issue 3:** Using both `.catch()` on each promise AND `Promise.allSettled` is redundant. `Promise.allSettled` already handles rejections. Pick one pattern.
- ⚠️ **Issue 4:** The fix references `session.activeProjectId` but uses `s.transport.connectionId` — the variable naming is inconsistent (plan uses `session` for the outer scope and `s` for the lambda).
- ✅ The core idea (parallel broadcast with error isolation) is correct.

---

### F2. Store commit error drops in-flight events silently — ✅ CONFIRMED

**Claim:** If the store throws on event N in a batch, the error propagates to `handleMessage`'s catch block, which sends `"server_error"` and closes the session — **without ever sending `submit_events_result`**.

**Actual code (sync-server.js lines 691-730):**
```js
try {
  const { deduped, committedEvent } = await store.commitOrGetExisting({...});
  results.push({ id: committedEvent.id, status: "committed", ... });
  committedEvents.push(committedEvent);
  // ...
} catch (err) {
  const code = isObject(err) && typeof err.code === "string" ? err.code : null;
  if (code === "validation_failed" || code === "forbidden") {
    // These become rejected results
    pushRejected(item.id, ...);
    continue;
  }
  throw err;  // ← Re-throws for any OTHER error
}
```

After the loop, at line 733-740:
```js
await sendMessage(session.transport, "submit_events_result", { results }, { msgId: context.msgId });
```

**Verification:**
- ✅ If the store throws with an error that has `code !== "validation_failed"` and `code !== "forbidden"` (e.g., SQLITE_BUSY, disk full, connection error), the `throw err` at line 729 propagates out of `handleSubmit`.
- ✅ This skips the `sendMessage(... "submit_events_result" ...)` at line 733.
- ✅ The error then reaches the `receiveQueue` catch in `attachConnection` (line 1017), which sends `sendError("server_error", ...)` and calls `closeSession`.
- ✅ Events 0..N-1 were already committed + broadcast (line 692-702 + line 742-747), but the client never gets the `submit_events_result` confirming them.
- ⚠️ **The plan says "events 0..N-1 are already committed and broadcast"** — this is only true for events committed in prior iterations of the same batch. They're committed in the store AND pushed to `committedEvents[]`, but broadcast happens AFTER the loop at lines 742-747. If the error is thrown at event N, broadcast of ALL events (0..N-1) is also skipped because we never reach line 742. So **events are committed to the store but NOT broadcast**.

**Verdict:** Bug is real, but the plan's description that "events 0..N-1 are already committed and broadcast" is slightly wrong — they're committed but NOT broadcast since broadcast happens after the full loop.

**Proposed fix evaluation:**
```js
} catch (err) {
  const payloadError = toErrorPayload(err, "server_error", "Store commit failed");
  pushRejected(item.id, payloadError.code, payloadError.message);
  continue;
}
await sendMessage(session.transport, "submit_events_result", { results }, { msgId: context.msgId });
```

- ⚠️ **Issue 1:** The fix removes the special handling for `validation_failed` and `forbidden` error codes, converting ALL store errors to rejected results. This is intentional but changes behavior — previously, unrecognized store errors killed the session; now they're soft failures. This may mask serious issues (e.g., disk full, database corruption) that should arguably still kill the session.
- ⚠️ **Issue 2:** The fix uses `pushRejected` which sets `blockedById = id` (line 525). This means all subsequent events in the batch become `not_processed` even though the store might be fine for them. The fix should use a different mechanism that doesn't block subsequent events, or at least make this a deliberate design choice.
- ✅ Ensures `submit_events_result` is always sent — correct.

**Recommended improvement:** Add a `pushStoreError` that doesn't set `blockedById`, or differentiate between transient and permanent errors.

---

### F3. No graceful shutdown — in-flight data lost — ✅ CONFIRMED

**Claim:** `shutdown()` immediately closes all sessions. In-flight operations are lost.

**Actual code (sync-server.js lines 1040-1045):**
```js
shutdown: async () => {
  const ids = [...sessions.keys()];
  for (const connectionId of ids) {
    await closeSession(connectionId, "shutdown");
  }
},
```

**Verification:**
- ✅ There is no drain mechanism. No `shuttingDown` flag to reject new messages.
- ✅ In-flight operations (e.g., `handleSubmit` currently processing event 25 of 50) will have their sessions closed mid-operation.
- ✅ No notification to clients that shutdown is happening.
- ✅ `ws-server-runtime.js` has a `detach()` method (line 79-83) that's not called during shutdown.

**Verdict:** Bug is real. The current shutdown is immediate and destructive.

**Proposed fix evaluation:**
```js
shutdown: async () => {
  runtime.detach();
  shuttingDown = true;
  const drains = [...sessions.values()].map(s => s.inflight?.promise || Promise.resolve());
  await Promise.allSettled(drains);
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map(id => closeSession(id, "shutdown")));
}
```

- ⚠️ **Issue 1:** `s.inflight?.promise` — there is no `inflight` property on sessions in the current code. This is a new tracking mechanism that needs to be added to every session and updated for every async operation. The plan doesn't show how to implement this.
- ⚠️ **Issue 2:** If an in-flight operation hangs forever (e.g., store query blocked on lock), the drain will hang forever. There's no timeout. The plan needs a `Promise.race` with a configurable timeout (e.g., 30 seconds).
- ⚠️ **Issue 3:** `shuttingDown = true` is checked... where? The plan doesn't show the check in `receive()` or `handleMessage()`. This flag needs to be added and checked.
- ⚠️ **Issue 4:** The current `shutdown` is in the return object of `createSyncServer` — it has no access to `runtime` (the ws-server-runtime). The plan references `runtime.detach()` but the server doesn't hold a reference to the runtime. The runtime wraps the server, not the other way around.
- ✅ The phased approach (stop accepting → drain → close) is the correct pattern.

**Recommended fix:** Add a `shutdownTimeout` (e.g., 10s) for the drain phase. Track in-flight ops with a simple counter + promise pair. Have `runtime.closeAllConnections()` be called after drain.

---

### F4. receiveQueue unhandled rejection — ⚠️ PARTIALLY CONFIRMED

**Claim:** If `sendError` itself throws inside the catch block, the rejection escapes into the void. In Node.js, this triggers `unhandledRejection` which can crash the process.

**Actual code (sync-server.js lines 1007-1033):**
```js
receiveQueue = receiveQueue
  .catch(() => {})       // ← swallows previous error
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch {
      await sendError(session.transport, "server_error", "Unexpected server error", {}, { msgId: inboundMsgId });
      await closeSession(session.transport.connectionId, "server_error");
    }
  });
return receiveQueue;
```

**Verification:**
- ✅ The pattern is `.catch(() => {}).then(async () => { ... })`.
- ✅ If `sendError` or `closeSession` throws inside the `catch` block (lines 1018-1030), the resulting rejection propagates from the `.then()` handler, creating a rejected promise.
- ✅ There is no terminal `.catch()` on the chain — so this rejection IS unhandled.
- ⚠️ **Overstatement:** The plan says "In Node.js, this triggers `unhandledRejection` which can crash the process." This was true in Node.js < 15. Since Node.js 15 (released Oct 2020), unhandled rejections cause the process to exit with a non-zero code by default. They don't "crash" in the traditional sense (no stack trace dump) — they cause a clean exit. But the impact is still real: the server shuts down.
- ⚠️ **Additional concern the plan misses:** There's actually a MORE subtle issue. The `.catch(() => {})` swallows the error from the *previous* iteration, but if the `.then()` handler itself rejects (from `sendError` throwing), the NEXT message's `.catch(() => {})` will swallow it. So the unhandled rejection only occurs if the error happens on the LAST message processed before the connection closes. If there's a subsequent message, its `.catch(() => {})` will catch it. This is still a bug, but it's less likely to cause crashes than the plan implies.

**Verdict:** The bug is real but the severity is context-dependent. It's most dangerous during connection teardown when `sendError` fails on the final message.

**Proposed fix evaluation:**
```js
receiveQueue = receiveQueue
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch (err) {
      try { await sendError(...); } catch {}
      try { await closeSession(...); } catch {}
    }
  })
  .catch(() => {});  // ← terminal catch, always last
```

- ✅ Moving `.catch()` to the end ensures it always catches, regardless of where the rejection comes from.
- ✅ Wrapping `sendError` and `closeSession` in `try/catch` prevents secondary failures from creating new rejections.
- ✅ This is the correct fix pattern.
- ⚠️ **Minor issue:** The `.catch(() => {})` swallows ALL errors silently, making debugging harder. Should at least log: `.catch(err => log({ event: "receive_queue_error", error: String(err) }))`.

---

## Performance Killer Validation

### P1. O(n) broadcast scan on every commit — ✅ CONFIRMED

**Claim:** `broadcastCommitted` does `[...sessions.values()].filter(...)` — iterates ALL sessions on every committed event. For a batch of N events and S total sessions: O(N × S).

**Actual code (sync-server.js line 426):**
```js
const recipients = [...sessions.values()].filter(
  (session) =>
    session.state === "active" &&
    session.transport.connectionId !== originConnectionId &&
    !session.syncInProgress &&
    session.activeProjectId === committedEvent.projectId,
);
```

**Verification:**
- ✅ This creates a new array from ALL sessions on every broadcast call.
- ✅ For a 50-event batch with 10K sessions: 500K iterations + 500K array allocations.
- ✅ The plan's line reference ("line 426") is accurate.

**Proposed fix evaluation:**
```js
const projectSessions = new Map();  // projectId → Set<connectionId>
const recipientIds = projectSessions.get(committedEvent.projectId) ?? [];
```

- ✅ Correct approach. Reduces iteration to only sessions for the relevant project.
- ⚠️ **Missing:** The plan doesn't show where `projectSessions` is updated on connect/disconnect. This needs to be added to `handleConnect` (when `activeProjectId` is set), `closeSession` (on disconnect), and `handleSync` (which sets `activeProjectId` at line 822 — though this looks like it's redundant since sync only works with the already-set project).
- ⚠️ **Edge case:** If a session is in `syncInProgress` state, it's excluded from broadcast. The `projectSessions` index doesn't track this — the filter still needs to check `!session.syncInProgress`. The plan's fix shows this correctly in the code snippet.

---

### P2. Write amplification: 3 SQL statements per event — ⚠️ PARTIALLY CONFIRMED

**Claim:** Each `commitOrGetExisting` executes 3 SQL statements: SELECT (dedup), INSERT, SELECT (readback). Each in its own `BEGIN IMMEDIATE` transaction.

**SQLite store (sqlite-sync-store.js lines 253-317):**
The `commitTxn` is wrapped in `createTransaction(db, fn)` which wraps the entire operation in `BEGIN IMMEDIATE` ... `COMMIT`. Inside:
1. `getByIdStmt.get({ id })` — SELECT for dedup (line 266)
2. If not existing: `insertCommittedStmt.run(...)` — INSERT (line 293)
3. `getByIdStmt.get({ id })` — SELECT readback (line 307)

**Verification:**
- ✅ 3 SQL statements per event in the non-dedup case (SELECT + INSERT + SELECT).
- ⚠️ **The plan is wrong about "each in its own transaction."** All 3 statements execute within a single `createTransaction` wrapper. Looking at `createTransaction` (lines 8-28): it wraps the entire function in `BEGIN IMMEDIATE` ... `COMMIT`. So it's **1 transaction** with 3 statements, not 3 transactions.
- ✅ The readback SELECT (line 307-309) IS redundant for the insert case — the INSERT already gives us `lastInsertRowid` via `info.lastInsertRowid` (though the code doesn't use it and instead does a re-read).
- ⚠️ **For the dedup case:** only 1 SELECT is executed (lines 266, 278-290), not 3 statements. The plan doesn't distinguish.

**LibSQL store (libsql-sync-store.js lines 206-284):**
1. `INSERT ... ON CONFLICT(id) DO NOTHING` — single statement (line 229)
2. `getById(id)` — SELECT readback (line 261)

**Verification:**
- ✅ LibSQL uses `ON CONFLICT DO NOTHING` which combines dedup + insert into 1 statement, then reads back.
- ✅ The plan's claim of "3 statements" is only accurate for SQLite, not LibSQL.
- ⚠️ **The plan says LibSQL has "no transaction in commit"** in the robustness checklist. This is correct — the LibSQL `commitOrGetExisting` does NOT wrap the INSERT + readback in a transaction. There's a TOCTOU race: two concurrent commits with the same ID could both pass the INSERT (one inserts, one does nothing on conflict) but the readback is outside any transaction boundary.

**Proposed batch commit fix evaluation:**
```js
async commitBatch(items) {
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const ids = items.map(i => i.id);
    const existing = db.prepare(
      `SELECT id, committed_id, server_ts FROM committed_events WHERE id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    // ...
    db.prepare("COMMIT").run();
  } catch {
    db.prepare("ROLLBACK").run();
    throw;
  }
}
```

- ⚠️ **SQL injection vulnerability in the fix:** The plan uses string interpolation to build the IN clause: `(${ids.map(() => '?').join(',')})`. This is actually safe because it uses parameterized placeholders (`?`), not raw values. ✅ This is correct.
- ⚠️ **Empty batch edge case:** If `items` is empty, `ids` is empty, and the SELECT becomes `WHERE id IN ()` which is invalid SQL. The fix should check for empty batch first.
- ⚠️ **All-duplicates edge case:** If all items are duplicates, the INSERT statement is never executed but `COMMIT` still runs. This is correct behavior.
- ⚠️ **Canonicalization is missing from the fix:** The current `commitOrGetExisting` in both stores runs `canonicalizeSubmitItem` to generate a `comparisonKey` for dedup verification (different payload with same ID → error). The proposed batch fix skips this entirely. It would silently accept events with the same ID but different payloads.
- ⚠️ **The fix uses `db.prepare("BEGIN IMMEDIATE").run()`** — this is synchronous `better-sqlite3` API. The actual store uses `createTransaction()` wrapper. The fix should use the same pattern for consistency.
- ⚠️ **`insertStmt.run(item.id, item.partition, ...)`** — the fix uses positional parameters (`?`), but the actual prepared statements use named parameters (`@id`, `@partition`, etc.). The fix would need to use the correct parameter style.

**Verdict:** The performance concern is real, but the fix has several correctness gaps (missing canonicalization, empty batch, parameter style mismatch).

---

### P3. No backpressure on WebSocket sends — ✅ CONFIRMED (but nuanced)

**Claim:** `ws.send(JSON.stringify(message))` is fire-and-forget with no `bufferedAmount` check.

**Actual code (ws-server-bridge.js lines 51-55):**
```js
send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
  log("message_sent", { messageType: message?.type || null });
},
```

**Verification:**
- ✅ No `bufferedAmount` check.
- ✅ `ws.send()` is synchronous in the `ws` library and buffers data in memory when the kernel buffer is full.
- ✅ The `send` function is declared `async` but never `await`s anything — it's fire-and-forget.
- ⚠️ **Nuance the plan misses:** The `send` function already has a guard for `ws.readyState !== ws.OPEN`. It silently drops messages to closed sockets. This is good but doesn't address backpressure.
- ⚠️ **The plan's fix references `ws.once("drain", resolve)` but the `ws` library's `drain` event is not a standard WebSocket event.** The `ws` library does NOT emit a `drain` event. Instead, `ws.send()` accepts a callback that fires when the data is flushed. The correct backpressure pattern for `ws` is:
  ```js
  ws.send(data, (err) => { /* callback when data is written to kernel */ });
  ```
  Or check `ws.bufferedAmount` before each send. The plan's `ws.once("drain")` approach would simply hang forever.

**Proposed fix evaluation:**
- ❌ `ws.once("drain", resolve)` will never resolve — `ws` doesn't emit a `drain` event.
- ✅ The `bufferedAmount` check before sending is the correct approach.
- ✅ Dropping broadcast messages under backpressure is reasonable for real-time data.
- ⚠️ **The fix makes `send` actually async** (it awaits), which changes the behavior. Currently `send` returns immediately. With the fix, calls that hit the drain path will block. This is correct for backpressure but means callers need to handle potential delays.

**Recommended fix:** Use callback-based `ws.send(data, callback)` or simply check `ws.bufferedAmount` and drop/skip without the fake `drain` event.

---

### P4. Per-event authorization check in batch — ✅ CONFIRMED

**Claim:** `handleSubmit` calls `authz.authorizeProject(identity, item.projectId)` for every event in the batch, even though all events must have `projectId === session.activeProjectId`.

**Actual code (sync-server.js lines 652-659):**
```js
const authorized = await authz.authorizeProject(
  session.identity,
  item.projectId,
);
if (!authorized) {
  pushRejected(item.id, "forbidden", "project access denied");
  continue;
}
```

**Verification:**
- ✅ This is inside the `for (let index = 0; index < payload.events.length; index += 1)` loop at line 552.
- ✅ `item.projectId` is validated to equal `session.activeProjectId` at lines 643-649. If it doesn't match, it's rejected before reaching the authz call.
- ✅ So by line 652, `item.projectId === session.activeProjectId` is guaranteed.
- ✅ The authorization result is the same for every iteration: same identity, same projectId.
- ✅ The plan's line reference ("line 652-659") is accurate.

**Proposed fix evaluation:**
```js
// Before the loop:
const authorized = await authz.authorizeProject(session.identity, session.activeProjectId);
if (!authorized) { /* reject entire batch */ }

// Inside the loop: remove the authz call
```

- ✅ Correct approach.
- ⚠️ **Edge case:** What if `session.activeProjectId` is null (shouldn't happen since `handleConnect` sets it, but defensive programming)? The fix should validate `activeProjectId` is non-null before the authz call.
- ⚠️ **The plan says "reject entire batch" but doesn't show how.** Should it send `submit_events_result` with all events rejected, or send an `error` message and close the session? The current per-event approach sends individual rejections. The batch rejection should be consistent with the protocol.

---

### P5. Canonicalization on every commit including duplicates — ⚠️ PARTIALLY INACCURATE

**Claim:** `canonicalizePayload` runs `deepSortKeys` + `JSON.stringify` on the full payload for every commit, even for duplicate events.

**Actual code:**

Looking at the stores:
- **SQLite (sqlite-sync-store.js lines 268-276):** `canonicalizeSubmitItem` is called at the START of `commitTxn`, BEFORE the dedup check. So canonicalization runs even for duplicates. ✅ This confirms the claim for SQLite.
- **LibSQL (libsql-sync-store.js lines 218-227):** `canonicalizeSubmitItem` is called at the START of `commitOrGetExisting`, BEFORE the INSERT. ✅ Confirms for LibSQL.
- **In-Memory (in-memory-sync-store.js lines 32-40):** `canonicalizeSubmitItem` is called before the `byId.get(id)` dedup check. ✅ Confirms for in-memory.

**Verification:**
- ✅ Canonicalization runs on every call, including duplicates.
- ⚠️ **The plan is inaccurate about what `canonicalizeSubmitItem` does.** It says "runs `deepSortKeys` + `JSON.stringify` on the full payload." Looking at `canonicalize.js`, it actually:
  1. Calls `normalizeMeta(meta, ...)` — normalizes metadata
  2. Calls `deepSortKeys(payload)` — sorts object keys recursively
  3. Calls `deepSortKeys(normalizedMeta)` — sorts meta keys
  4. Calls `JSON.stringify(...)` on the combined object
  So it canonicalizes the WHOLE event (partition, projectId, userId, type, schemaVersion, payload, meta), not just the payload. The plan's "canonicalizePayload" function name is made up — the actual function is `canonicalizeSubmitItem`.

**Proposed fix evaluation:**
```js
// Option A: Dedup first, canonicalize only on insert
const existing = await checkExists(id);
if (existing) return { deduped: true, existing };
const canonicalPayload = canonicalizePayload(payload);
```

- ⚠️ **The fix is fundamentally flawed for SQLite.** In `sqlite-sync-store.js`, canonicalization is used for COMPARISON — when a duplicate ID is found, the canonical key of the new submission is compared against the canonical key of the existing row to detect payload mismatches (line 280: `toComparisonKey(parsedExisting) !== comparisonKey`). If we skip canonicalization before the dedup check, we can't detect mismatches.
- ⚠️ **For the LibSQL store:** Same issue. The comparison at line 268 checks `toComparisonKey(parsed) !== comparisonKey`. We need the comparison key to verify the duplicate has the same payload.
- ⚠️ **The fix would work for in-memory store** since the `byId` map already stores the `comparisonKey` alongside the event.
- ⚠️ **The plan says "defer canonicalization" but doesn't address the comparison requirement.** For stores that need to compare, you'd need to either: (a) store the comparison key in the database, or (b) always canonicalize on read for comparison. Option (a) would be a schema change.

**Verdict:** The performance concern is real but the proposed fix breaks the duplicate-detection-with-payload-verification feature. A correct fix would require storing the canonical key in the database.

---

### P6. Sequential broadcast per event — ✅ CONFIRMED

**Claim:** Events are broadcast one at a time in a sequential loop.

**Actual code (sync-server.js lines 742-747):**
```js
for (const committedEvent of committedEvents) {
  await broadcastCommitted({
    originConnectionId: session.transport.connectionId,
    committedEvent,
  });
}
```

**Verification:**
- ✅ Sequential `for...of` with `await` on each broadcast call.
- ✅ Each `broadcastCommitted` call itself iterates through all recipients sequentially (as confirmed in F1).
- ✅ For 50 events × 100 recipients: 5,000 sequential await chains.

**Proposed fix evaluation:**
```js
const broadcastCommittedBatch = async ({ originConnectionId, events }) => {
  const recipients = (projectSessions.get(events[0].projectId) ?? [])
    .filter(cid => cid !== originConnectionId);
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

- ⚠️ **Issue:** `events[0].projectId` assumes all events have the same projectId. This is guaranteed by the current validation (all events must match `session.activeProjectId`), so this is safe. ✅
- ⚠️ **Issue:** Each event gets a separate `sendMessage` call, sending separate WebSocket messages. A more efficient approach would batch all events into a single message. But the protocol may not support batch broadcast messages.
- ⚠️ **Issue:** The `.catch(() => scheduleSessionCleanup(cid))` wraps `Promise.allSettled()`. Since `Promise.allSettled` never rejects, this catch will never fire. The error handling for individual send failures is missing. Each `sendMessage` in the `.map()` needs its own `.catch()`.
- ✅ The core idea (batch all events, send to each recipient in parallel) is correct.

---

## Additional Findings Not in the Plan

### A1. `syncInProgress` never reset on error — CONFIRMED (Plan mentions this in checklist)

In `handleSync` (sync-server.js lines 822-872), `session.syncInProgress = true` is set at line 823, but only reset at line 870 (`session.syncInProgress = false`) when `!page.hasMore`. If `listCommittedSince` throws (store error), the function exits via the `receiveQueue` catch, and `syncInProgress` remains `true` forever — the session will never receive broadcasts again.

The plan mentions this in the "Session Lifecycle" table but doesn't give it a dedicated fix section. This should be a fatal bug (F5).

### A2. `closeSession` can throw and leave zombie sessions

`closeSession` (sync-server.js lines 206-217) calls `await session.transport.close()`. If this throws (e.g., WebSocket already terminated), the session remains in the `sessions` map with `state = "closed"` but is NOT deleted from the map (line 210 runs before line 211's await). Wait — actually lines 209-210 run synchronously:
```js
session.state = "closed";
sessions.delete(connectionId);
await session.transport.close(undefined, reason);
```

The `delete` happens BEFORE the `await`, so the session IS removed from the map even if `close()` throws. But if `close()` throws, the error propagates to the caller. In the `shutdown` loop (line 1042-1044), this means one failed close aborts shutdown for all remaining sessions. ✅ This is caught by the plan's F3 fix (using `Promise.allSettled`).

### A3. SQLite `ensureInitialized` has no concurrency protection

In `sqlite-sync-store.js` lines 320-326, `ensureInitialized()` is synchronous but not protected against concurrent calls. If two `commitOrGetExisting` calls happen simultaneously on the first use, both could run `runPragmas()`, `initializeSchema()`, and `prepareStatements()`. The plan mentions this in the "Store Robustness" table. The LibSQL store already handles this with `initPromise` (lines 183-198). ✅ Plan addresses this.

### A4. Race condition in `handleSync` — `activeProjectId` reassignment

At line 822: `session.activeProjectId = normalizedProjectId;` — this reassigns `activeProjectId` even though it was already validated to equal the current value (line 790). This is harmless but redundant. Not a bug.

### A5. Broadcast of deduped events

Looking at `handleSubmit`, the broadcast loop at line 742 iterates over `committedEvents[]`. Events are pushed to this array at line 702 only when the store returns successfully. But `deduped` events ARE also pushed (line 702 is inside the try block that handles both deduped and non-deduped cases). So deduped events ARE re-broadcast. This is correct behavior (other subscribers may not have seen the event), but it means the same event can be broadcast multiple times if the same client submits it multiple times. This is by design but worth noting.

---

## Summary Table

| ID | Claim | Verdict | Line Accuracy | Fix Correct? |
|---|---|---|---|---|
| F1 | Broadcast cascade | ✅ Confirmed | ✅ Accurate | ⚠️ Mostly, minor issues |
| F2 | Store error drops batch | ✅ Confirmed | ✅ Accurate | ⚠️ Changes error semantics |
| F3 | No graceful shutdown | ✅ Confirmed | ✅ Accurate | ⚠️ Needs timeout + inflight tracking |
| F4 | receiveQueue rejection | ⚠️ Partially confirmed | ✅ Accurate | ✅ Correct |
| P1 | O(n) broadcast scan | ✅ Confirmed | ✅ Accurate | ✅ Correct |
| P2 | 3 SQL per event | ⚠️ 1 transaction, not 3 | ⚠️ Overstated | ❌ Missing canonicalization |
| P3 | No backpressure | ✅ Confirmed | ✅ Accurate | ❌ `drain` event doesn't exist |
| P4 | Per-event authz | ✅ Confirmed | ✅ Accurate | ✅ Correct |
| P5 | Canonicalization waste | ⚠️ Can't defer for dedup | ⚠️ Wrong fix | ❌ Breaks dedup comparison |
| P6 | Sequential broadcast | ✅ Confirmed | ✅ Accurate | ⚠️ Error handling issue |

---

## Missed Issues

1. **`syncInProgress` stuck on error** — should be F5. The `handleSync` function never resets this flag in error paths.
2. **LibSQL TOCTOU race** — `commitOrGetExisting` does INSERT then SELECT without a transaction. Two concurrent calls could interleave.
3. **No rate limiting on sync** — a client can spam `sync` requests to saturate the store.
4. **No maximum batch size** — `submit_events` has no upper bound on batch size. A malicious client could submit 10,000 events in one message.
5. **`createServerMsgId` is not atomic** — `nextServerMsgId += 1` is safe in single-threaded Node.js but worth noting for future worker-thread compatibility.
6. **Memory leak in LibSQL `initPromise`** — if initialization succeeds, `initPromise` is never cleared. For long-running processes this is negligible, but it keeps a reference to the resolution function unnecessarily.

---

## Recommendations for the Plan

1. **Fix F1:** Use `Promise.allSettled` but remove the redundant `.catch()` on individual promises. Define `scheduleSessionCleanup`.
2. **Fix F2:** Don't use `pushRejected` for store errors (it sets `blockedById`). Create a separate `pushStoreError` function that doesn't block subsequent events.
3. **Fix F3:** Add a drain timeout (e.g., 10s). Track in-flight operations with a counter. Add `shuttingDown` flag check in `receive()`.
4. **Fix P2:** The batch commit MUST include canonicalization for comparison, or store the canonical key in the database.
5. **Fix P3:** Remove `ws.once("drain")`. Use `ws.send(data, callback)` or just `bufferedAmount` check with drop.
6. **Fix P5:** Skip — the "optimization" breaks correctness. Instead, optimize `canonicalizeSubmitItem` itself (memoize, cache).
7. **Add F5:** `syncInProgress` stuck on error — add `finally { session.syncInProgress = false; }` in `handleSync`.
8. **Add max batch size** — limit `payload.events.length` to prevent abuse.
