# Insieme v3 — FINAL Implementation Plan

**Date**: 2025-05-08
**Status**: Definitive — supersedes CLEAN-INTERFACE-PLAN.md and BACKEND-ROBUSTNESS-PERFORMANCE-PLAN.md
**Incorporates**: All corrections from VALIDATION-1 through VALIDATION-5

---

## What This Document Is

This is the single, authoritative implementation plan for Insieme v3. It merges the Clean Interface Plan and the Backend Robustness & Performance Plan, incorporating all 15 critical/significant issues found during validation. A developer should be able to implement from this document alone without reading any other file.

---

## Table of Contents

1. [Corrected Implementation Order](#corrected-implementation-order)
2. [Phase 0: Fix Fatal Server Bugs](#phase-0-fix-fatal-server-bugs)
3. [Phase 1: TypeScript Foundation](#phase-1-typescript-foundation)
4. [Phase 2: Storage Unification](#phase-2-storage-unification)
5. [Phase 3: Server Performance](#phase-3-server-performance)
6. [Phase 4: Client FSM + Error Hierarchy](#phase-4-client-fsm--error-hierarchy)
7. [Phase 5: Projections](#phase-5-projections)
8. [Phase 6: Scalability (Optional)](#phase-6-scalability-optional)
9. [What NOT to Do](#what-not-to-do)
10. [Corrected Interface Reference](#corrected-interface-reference)

---

## Corrected Implementation Order

The original proposals had the wrong ordering. Validation found hidden dependencies and confirmed that TypeScript and server bug fixes should come first.

```
Phase 0: Fix fatal server bugs (F1–F5)          — 2-3 days, immediate production fix
Phase 1: TypeScript conversion                    — 2-3 days, foundation for all phases
Phase 2: Storage unification (biggest reduction)  — 5-7 days, depends on Phase 1
Phase 3: Server performance (P1–P6)               — 3-5 days, depends on Phase 2 for batch commit
Phase 4: Client FSM + error hierarchy             — 3-5 days, depends on Phase 2 for new store interface
Phase 5: Projections on session                   — 5-7 days, depends on Phase 4 for FSM + Phase 2 for unified store
Phase 6: Scalability (Redis, sharding)            — 10-15 days, optional, for scale
```

**Why this order:**
- Phase 0 is independent — fixes actual production bugs, no dependencies
- Phase 1 (TypeScript) must come before all other phases so interfaces are type-checked as we go
- Phase 2 depends on Phase 1 (type-safe interfaces)
- Phase 3 depends on Phase 2 (batch commit needs unified store adapter)
- Phase 4 depends on Phase 2 (FSM needs new store's applySubmitResult returning SubmitResult)
- Phase 5 depends on Phase 4 (session needs FSM for status) AND Phase 2 (projection needs unified checkpoint interface)

---

## Phase 0: Fix Fatal Server Bugs

**Estimated effort:** 2-3 days
**Risk:** Low — targeted patches to existing code
**Dependencies:** None

### 0.1 F1: Broadcast failure cascades to all subscribers

**File:** `src/sync-server.js`
**What's wrong:** Sequential `await sendMessage` in `broadcastCommitted` (lines 434-446). If one recipient's send throws, the loop aborts — remaining recipients never get the event, and the submitter's session is killed.

**Corrected fix:**
```js
// Replace the for-loop in broadcastCommitted (around line 434-446):
const broadcastCommitted = async ({ originConnectionId, committedEvent }) => {
  const recipientIds = projectSessions.get(committedEvent.projectId) ?? [];
  const tasks = [];
  for (const cid of recipientIds) {
    if (cid === originConnectionId) continue;
    const session = sessions.get(cid);
    if (!session || session.state !== "active" || session.syncInProgress) continue;
    tasks.push(
      sendMessage(session.transport, "event_broadcast", committedEvent, {
        msgId: createServerMsgId(),
      }).catch((err) => {
        log({
          event: "broadcast_failed",
          connectionId: cid,
          error: String(err),
        });
        // Schedule cleanup — don't cascade
        closeSession(cid, "broadcast_failed").catch(() => {});
      })
    );
  }
  await Promise.allSettled(tasks);
};
```

**Correction note:** The original proposal used both `.catch()` on each promise AND `Promise.allSettled` — that's redundant. Use `Promise.allSettled` for the outer wait and `.catch()` on individual promises for per-recipient error handling. Also, the original referenced `scheduleSessionCleanup` which doesn't exist — use `closeSession` with a catch guard instead.

**Test strategy:** Unit test with 5 mock recipients where recipient 2 throws. Verify recipients 1, 3, 4, 5 still receive the event and the submitter's session stays alive.

---

### 0.2 F2: Store commit error drops in-flight events silently

**File:** `src/sync-server.js`
**What's wrong:** If the store throws on event N in a batch (non-validation error like SQLITE_BUSY), the error propagates to `handleMessage`'s catch, which sends `server_error` and closes the session — without ever sending `submit_events_result`. Events 0..N-1 are committed to the store but the client never knows.

**Corrected fix:**
```js
// In handleSubmit, inside the per-event loop (around line 712-730):
} catch (err) {
  const code = isObject(err) && typeof err.code === "string" ? err.code : null;
  if (code === "validation_failed" || code === "forbidden") {
    pushRejected(item.id, code, err.message || "Validation failed");
    continue;
  }
  // FIX: Don't re-throw. Convert to a result entry without blocking subsequent events.
  results.push({
    id: item.id,
    status: "rejected",
    reason: "server_error",
    message: err.message || "Store commit failed",
  });
  // Do NOT call pushRejected here — it sets blockedById which blocks ALL subsequent events.
  // Instead, just push a result and let remaining events proceed.
  log({ event: "store_commit_error", id: item.id, error: String(err) });
  continue;
}
```

**Correction note:** The original proposal used `pushRejected()` for store errors. This is wrong because `pushRejected` sets `blockedById = item.id`, which causes ALL subsequent events in the batch to become `not_processed`. Instead, push the result directly without setting `blockedById`. This allows subsequent events to attempt their own commit.

Also note: The original proposal removed the special handling for `validation_failed` and `forbidden` — that's wrong. Those should stay as-is since they are intentional server logic. Only unrecognized errors should be converted to soft rejections.

**Test strategy:** Submit a batch of 5 events where event 2 triggers a simulated store error. Verify: events 0, 1 are committed; event 2 is rejected with `server_error`; events 3, 4 proceed normally; `submit_events_result` is always sent.

---

### 0.3 F3: No graceful shutdown

**File:** `src/sync-server.js`, `src/ws-server-runtime.js`
**What's wrong:** `shutdown()` immediately closes all sessions. In-flight operations are lost.

**Corrected fix:**
```js
// In createSyncServer's return object, replace the shutdown function:

// Add tracking state:
let shuttingDown = false;
let inflightCount = 0;
let inflightResolver = null;
const inflightPromise = () => new Promise((resolve) => { inflightResolver = resolve; });

function inflightBegin() {
  if (shuttingDown) return false;
  inflightCount++;
  return true;
}

function inflightEnd() {
  inflightCount--;
  if (inflightCount === 0 && inflightResolver) {
    inflightResolver();
    inflightResolver = null;
  }
}

// In receive(), before processing:
if (shuttingDown) {
  sendError(transport, "server_shutting_down", "Server is shutting down").catch(() => {});
  return;
}
if (!inflightBegin()) return;
try {
  // ... existing message handling ...
} finally {
  inflightEnd();
}

// Shutdown function:
shutdown: async () => {
  const SHUTDOWN_DRAIN_TIMEOUT_MS = 10000; // 10 seconds

  // Phase 1: Stop accepting new connections
  if (runtime && typeof runtime.detach === "function") {
    runtime.detach();
  }

  // Phase 2: Stop accepting new messages
  shuttingDown = true;

  // Phase 3: Drain in-flight operations with timeout
  if (inflightCount > 0) {
    const drainPromise = inflightPromise();
    await Promise.race([
      drainPromise,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
    ]);
  }

  // Phase 4: Close sessions gracefully
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map((id) => closeSession(id, "shutdown")));
};
```

**Correction notes:**
1. The original referenced `s.inflight?.promise` — there is no `inflight` property on sessions. Use a counter-based approach instead.
2. Added a drain timeout (10s) — without it, a hung store query blocks shutdown forever.
3. The original called `runtime.detach()` but the server doesn't hold a reference to the runtime. The runtime wraps the server. This needs to be wired externally: the caller passes runtime as a parameter, or the server returns a shutdown function that the runtime invokes.
4. The `shuttingDown` flag must be checked in the `receive()` function — not shown in original.

**Test strategy:** Start a batch submit of 50 events, call shutdown after event 10 starts processing. Verify: all 50 events are committed or rejected, `submit_events_result` is sent, all sessions close cleanly.

---

### 0.4 F4: receiveQueue unhandled rejection

**File:** `src/sync-server.js`
**What's wrong:** If `sendError` throws inside the catch block, the rejection is unhandled. The `.catch(() => {})` is in the wrong position.

**Corrected fix:**
```js
// In attachConnection, replace the receiveQueue pattern (around line 1007-1032):
receiveQueue = receiveQueue
  .then(async () => {
    try {
      await handleMessage(session, message);
    } catch (err) {
      try {
        await sendError(
          session.transport,
          "server_error",
          "Unexpected server error",
          {},
          { msgId: inboundMsgId }
        );
      } catch {}
      try {
        await closeSession(session.transport.connectionId, "server_error");
      } catch {}
    }
  })
  .catch((err) => {
    // Terminal catch — always last, logs for debugging
    log({ event: "receive_queue_error", error: String(err) });
  });
```

**Test strategy:** Mock `sendError` to throw, send a message that triggers an error. Verify no unhandled rejection and the error is logged.

---

### 0.5 F5 (NEW): syncInProgress stuck forever on error

**File:** `src/sync-server.js`
**What's wrong:** In `handleSync`, `session.syncInProgress = true` is set at line 823 but only reset at line 870 when `!page.hasMore`. If `listCommittedSince` throws, the flag stays `true` forever — the session never receives broadcasts again.

**Fix:**
```js
// In handleSync, wrap the main logic in try/finally:
session.syncInProgress = true;
try {
  // ... existing sync logic ...
} finally {
  session.syncInProgress = false;
}
```

**Test strategy:** Make `listCommittedSince` throw on the first call. Verify `syncInProgress` is reset to false and subsequent broadcasts are received.

---

### 0.6 Add: Per-project session index (prerequisite for F1 and P1)

**File:** `src/sync-server.js`

```js
// Add at the top of createSyncServer:
const projectSessions = new Map(); // projectId → Set<connectionId>

// In handleConnect (when activeProjectId is set):
const projectSet = projectSessions.get(session.activeProjectId) || new Set();
projectSet.add(connectionId);
projectSessions.set(session.activeProjectId, projectSet);

// In closeSession:
if (session.activeProjectId) {
  projectSessions.get(session.activeProjectId)?.delete(connectionId);
}

// In broadcastCommitted (F1 fix above): use projectSessions instead of iterating all sessions
```

---

### 0.7 Add: Maximum batch size on server

**File:** `src/sync-server.js`

```js
const MAX_BATCH_SIZE = 500; // configurable

// In handleSubmit, before the event loop:
if (payload.events.length > MAX_BATCH_SIZE) {
  await sendMessage(
    session.transport,
    "submit_events_result",
    {
      results: payload.events.map((e) => ({
        id: e.id,
        status: "rejected",
        reason: "submit_batch_too_large",
        message: `Batch size ${payload.events.length} exceeds maximum ${MAX_BATCH_SIZE}`,
      })),
    },
    { msgId: context.msgId }
  );
  return;
}
```

---

### Phase 0 Summary

| Item | Lines changed | Priority |
|------|:---:|:---:|
| F1: Broadcast cascade | ~15 | Critical |
| F2: Store error drops events | ~10 | Critical |
| F3: Graceful shutdown | ~40 | Critical |
| F4: receiveQueue rejection | ~10 | Critical |
| F5: syncInProgress stuck | ~5 | Critical |
| Per-project session index | ~15 | High |
| Max batch size | ~15 | High |
| **Total** | **~110 lines** | |

---

## Phase 1: TypeScript Foundation

**Estimated effort:** 2-3 days
**Risk:** Medium — mechanical conversion, but must not break runtime
**Dependencies:** None (after Phase 0)

### Why TypeScript First

The original proposal put TypeScript last (Phase 5). Validation confirmed this is wrong:
- Writing interfaces in `.ts` first catches type errors in all subsequent phases
- The corrected adapter interface, ClientStore interface, FSM types, and error hierarchy are all type definitions — they should be `.ts` files from the start
- Converting at the end means all intermediate code is untyped, defeating the purpose

### What to do

1. **Rename `.js` → `.ts`** for core files (use `ts-node` or build step)
2. **Create type definition files** for all corrected interfaces (see [Corrected Interface Reference](#corrected-interface-reference))
3. **Enable strict mode** in `tsconfig.json`
4. **Port existing `.d.ts` files** into source

### Files to create

| File | Purpose | Lines |
|------|---------|:---:|
| `src/types/adapter.ts` | StorageAdapter, SyncStoreAdapter interfaces | ~60 |
| `src/types/store.ts` | ClientStore, SyncStore, StoreStats types | ~50 |
| `src/types/client.ts` | SyncClient, ClientStatus, SubmitResult types | ~60 |
| `src/types/session.ts` | CommandSyncSession, CommandResult, ViewDefinition types | ~70 |
| `src/types/errors.ts` | Error hierarchy type definitions | ~40 |
| `src/types/events.ts` | CommittedEvent, DraftItem, CheckpointData, etc. | ~80 |
| `src/types/transport.ts` | Transport interface | ~20 |

### Test strategy

- All existing tests must pass with TypeScript compilation
- Type-check as part of CI pipeline
- No behavioral changes — pure conversion

---

## Phase 2: Storage Unification

**Estimated effort:** 5-7 days
**Risk:** High — largest code change, touches every store
**Dependencies:** Phase 1 (type-safe interfaces)

### Corrected Adapter Interface

The original proposal had 13 methods. Validation found that `deleteDrafts(ids[])` doesn't exist (stores use single delete), and several methods were missing. The corrected adapter has **12 methods** (9 required + 3 optional):

```ts
interface StorageAdapter {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Drafts (adapter handles draftClock generation internally)
  insertDrafts(items: DraftInput[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftRow[]>;
  deleteDraft(id: string): Promise<void>;

  // Committed
  insertCommittedEvent(event: CommittedInput): Promise<{ inserted: boolean }>;
  getCommittedById(id: string): Promise<CommittedRow | null>;
  listCommittedAfter(sinceCommittedId: number, limit: number): Promise<CommittedRow[]>;
  getMaxCommittedId(): Promise<number>;

  // Cursor
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;

  // Checkpoints (optional — return undefined or omit to opt out)
  loadCheckpoint?(viewName: string, partition: string): Promise<CheckpointData | undefined>;
  saveCheckpoint?(checkpoint: SaveCheckpointInput): Promise<void>;
  deleteCheckpoint?(viewName: string, partition: string): Promise<void>;
}
```

**Key corrections vs original proposal:**

| Change | Why |
|--------|-----|
| `deleteDraft(id: string)` instead of `deleteDrafts(ids: string[])` | No store has batch delete. Drafts are always deleted one at a time. |
| `insertDrafts` handles `draftClock` internally | SQLite stores use AUTOINCREMENT, In-Memory/IDB use manual counters. The adapter hides this. |
| `listCommittedAfter` uses positional params at adapter level | Adapter is internal, positional is fine. But the public ClientStore uses object params (see below). |

### Corrected ClientStore Interface

The original proposal was missing 5 public methods and had wrong signatures. The corrected interface:

```ts
interface ClientStore {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Drafts
  insertDraft(item: DraftItem): Promise<void>;
  insertDrafts(items: DraftItem[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftItem[]>;
  listDraftsOrdered(): Promise<DraftItem[]>;                      // ← ALIAS (preserved for compatibility)

  // Committed
  applySubmitResult(result: SubmitResult): Promise<void>;
  applyCommittedBatch(batch: { events: CommittedEvent[], nextCursor?: number }): Promise<void>;
  listCommitted(): Promise<CommittedEvent[]>;                     // ← was MISSING from proposal
  listCommittedAfter(opts: { sinceCommittedId?: number, limit?: number }): Promise<CommittedEvent[]>;  // ← object params, not positional

  // Cursor
  loadCursor(): Promise<number>;
  getCursor(): Promise<number>;                                    // ← ALIAS (preserved for compatibility)

  // Materialized views
  loadMaterializedView(query: { viewName: string, partition: string }): Promise<MaterializedViewValue>;
  subscribeMaterializedView(query: {
    viewName: string,
    partition: string,
    onChange: (value: ViewUpdate) => void,
    emitCurrent?: boolean,                                         // ← was MISSING from proposal
  }): Promise<Unsubscribe>;
  evictMaterializedView(query: { viewName: string, partition: string }): Promise<void>;      // ← was MISSING
  invalidateMaterializedView(query: { viewName: string, partition: string }): Promise<void>;  // ← was MISSING
  flushMaterializedViews(): Promise<void>;

  // Stats
  getStats(): Promise<StoreStats>;
}
```

**Key corrections:**

| Missing method | Why it must be preserved |
|----------------|-------------------------|
| `getCursor()` | All 5 stores expose it. Consumers use it. |
| `listDraftsOrdered()` | All 5 stores expose it. Consumers use it. |
| `listCommitted()` | All 5 stores expose it. Returns all committed events. |
| `subscribeMaterializedView` `emitCurrent` param | All stores pass it through. Runtime supports it. Consumers pass `emitCurrent: false`. |
| `evictMaterializedView()` | All stores expose it. Used for memory management in multi-partition views. |
| `invalidateMaterializedView()` | All stores expose it. Invalidates checkpoint + evicts + rehydrates for subscribers. |
| `listCommittedAfter` object params | All stores use `{sinceCommittedId, limit}` object destructure. Changing to positional breaks consumers. |

### `materialized-view-runtime.js`

**Keep as-is.** It's already shared across all stores. Do NOT delete it. The store core wires the adapter's checkpoint methods + `getMaxCommittedId` + `listCommittedAfter` to the runtime.

### `persisted-cursor-client-store.js`

**Keep as decorator.** It wraps any store and adds external cursor persistence. Do NOT absorb into core — it's a decorator pattern used only by consumers who need it.

### Files to create

| File | Purpose | Realistic Lines |
|------|---------|:---:|
| `src/store-core/client-store-core.ts` | Unified business logic (dedup, invariant, cursor monotonicity, MV wiring) | ~650 |
| `src/store-core/sync-store-core.ts` | Unified server store logic | ~200 |
| `src/store-core/row-codec.ts` | Shared serialization (handles both IDB and SQL codec strategies) | ~120 |
| `src/store-core/schema-manager.ts` | Shared DDL + schema validation for SQL stores | ~160 |
| `src/adapters/in-memory.ts` | In-memory adapter (Map-based, draftClock counter) | ~80 |
| `src/adapters/indexed-db.ts` | IndexedDB adapter (transaction wrapping, cursor traversal, schema migration) | ~200 |
| `src/adapters/sqlite.ts` | better-sqlite3 adapter (16 prepared statements, transaction wrapper) | ~180 |
| `src/adapters/libsql.ts` | LibSQL async adapter (async transactions, serializePayload) | ~200 |
| `src/adapters/async-sqlite.ts` | Tauri async adapter (read/write serialization, WAL management, op tracking) | ~300 |
| **Total new** | | **~2,090** |

### Files to delete

| File | Lines |
|------|:---:|
| `src/in-memory-client-store.js` | 336 |
| `src/indexeddb-client-store.js` | 742 |
| `src/sqlite-client-store.js` | 788 |
| `src/libsql-client-store.js` | 821 |
| `src/async-sqlite-client-store.js` | 978 |
| `src/materialized-view-runtime.js` | **KEEP** (already shared) |
| `src/persisted-cursor-client-store.js` | **KEEP** (decorator pattern) |
| **Total deleted** | **3,665** |

### Net reduction

- Delete: 3,665 lines
- Add: 2,090 lines
- **Net reduction: ~1,575 lines** while adding more features (stats, unified schema management)

### Test strategy

1. Port each adapter one at a time
2. Each adapter verified against its existing test suite before deleting old store
3. Integration test: create a store with each adapter, run full lifecycle (init → insert drafts → apply batch → load views → close)
4. Verify all existing tests pass with new implementation
5. Special attention to: In-Memory store's different dedup semantics, IDB cursor traversal, AsyncSQLite's serialization queue

---

## Phase 3: Server Performance

**Estimated effort:** 3-5 days
**Risk:** Medium — changes hot paths
**Dependencies:** Phase 2 (batch commit needs unified store adapter)

### P1: Per-project session index

**File:** `src/sync-server.js`
**Status:** ✅ Already done in Phase 0 (prerequisite for F1)

The `projectSessions` Map is added in Phase 0. No additional work needed.

### P2: Batch commit — reduce SQL round-trips

**File:** `src/sqlite-sync-store.ts`, `src/libsql-sync-store.ts`, `src/in-memory-sync-store.ts`

**What's wrong:** Each `commitOrGetExisting` runs SELECT (dedup) + INSERT + SELECT (readback) per event. For SQLite, this is 1 transaction with 3 statements per event, not 3 transactions as originally claimed.

**Corrected fix:**

```ts
async commitBatch(items: CommitInput[]): Promise<CommitResult[]> {
  if (items.length === 0) return [];

  const results: CommitResult[] = [];
  const db = this.db;

  // Use the existing createTransaction wrapper for consistency
  await createTransaction(db, () => {
    // Batch dedup: one query
    const ids = items.map((i) => i.id);
    const existingRows = getByIdsStmt.all(ids);
    const existingMap = new Map(existingRows.map((r) => [r.id, r]));

    for (const item of items) {
      const existing = existingMap.get(item.id);

      // CRITICAL: canonicalize BEFORE comparison — needed for dedup payload verification
      const canonicalItem = canonicalizeSubmitItem(item);

      if (existing) {
        const parsed = parseCommittedRow(existing);
        const comparisonKey = toComparisonKey(parsed);
        if (comparisonKey !== toComparisonKey(canonicalItem)) {
          throw Object.assign(new Error("Payload mismatch for duplicate id"), {
            code: "validation_failed",
          });
        }
        results.push({ deduped: true, committedEvent: parsed });
        continue;
      }

      // Insert new event — use lastInsertRowid to avoid readback SELECT
      const info = insertStmt.run({
        id: canonicalItem.id,
        partition: canonicalItem.partition,
        projectId: canonicalItem.projectId,
        userId: canonicalItem.userId,
        type: canonicalItem.type,
        schemaVersion: canonicalItem.schemaVersion,
        payload: serializePayload(canonicalItem.payload),
        meta: serializePayload(canonicalItem.meta),
        serverTs: canonicalItem.serverTs,
      });

      results.push({
        deduped: false,
        committedEvent: {
          ...canonicalItem,
          committedId: info.lastInsertRowid,
        },
      });
    }
  });

  return results;
}
```

**Correction notes:**
1. **Must include canonicalization** — the original proposal's fix skipped it, which would break dedup payload verification. Canonicalization is needed to compare the submitted event against the existing row's comparison key.
2. **Use `lastInsertRowid` from insert result** instead of re-reading — eliminates the readback SELECT.
3. **Empty batch check** — `if (items.length === 0) return []` prevents `WHERE id IN ()` which is invalid SQL.
4. **Use the store's existing `createTransaction` wrapper** and named parameter style (`@id`, `@partition`), not positional `?`.

**Cost for 50-event batch:** 150 statements → ~52 statements (1 batch SELECT + 50 inserts + 1 COMMIT). **3× improvement.**

### P3: WebSocket backpressure

**File:** `src/ws-server-bridge.ts`

**What's wrong:** `ws.send()` is fire-and-forget. No `bufferedAmount` check. Memory grows unbounded for slow clients.

**Corrected fix:**

```ts
const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB

send: async (message) => {
  if (ws.readyState !== ws.OPEN) return;
  const data = JSON.stringify(message);

  if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
    // Option A: Drop broadcast messages (acceptable for real-time)
    if (message.type === "event_broadcast") {
      log({ event: "backpressure_drop", bufferedAmount: ws.bufferedAmount });
      return;
    }
    // Option B: For critical messages, wait using ws.send callback
    await new Promise<void>((resolve, reject) => {
      ws.send(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return;
  }

  // Normal path: fire-and-forget with callback for error detection
  ws.send(data, (err) => {
    if (err) {
      log({ event: "ws_send_error", error: String(err) });
    }
  });
},
```

**CRITICAL CORRECTION:** The original proposal used `ws.once("drain", resolve)`. **The `ws` library does NOT emit a `drain` event.** That code would hang forever. Instead, use `ws.send(data, callback)` which is the correct backpressure mechanism for the `ws` library. The callback fires when the data is flushed to the kernel buffer.

### P4: Pre-loop authorization check

**File:** `src/sync-server.js`

**What's wrong:** `authz.authorizeProject(identity, item.projectId)` is called per event, but `item.projectId === session.activeProjectId` is already guaranteed.

**Fix:**
```js
// Before the event loop in handleSubmit:
const authorized = await authz.authorizeProject(session.identity, session.activeProjectId);
if (!authorized) {
  // Reject entire batch
  const results = payload.events.map((item) => ({
    id: item.id,
    status: "rejected",
    reason: "forbidden",
    message: "Project access denied",
  }));
  await sendMessage(
    session.transport,
    "submit_events_result",
    { results },
    { msgId: context.msgId }
  );
  return;
}

// Remove the per-event authz call from inside the loop
```

### P5: Canonicalization — SKIP THIS OPTIMIZATION

**Status:** ❌ DO NOT IMPLEMENT the original proposal's fix.

**Why:** The original proposal suggests deferring canonicalization to after the dedup check. This is **fundamentally incorrect** — canonicalization is needed BEFORE the dedup check to compute the comparison key for payload mismatch detection. If two submissions have the same ID but different payloads, the server must reject the second one. Without canonicalization, this detection is impossible.

**Alternative:** Optimize `canonicalizeSubmitItem` itself (memoize `deepSortKeys`, cache `JSON.stringify` for identical inputs). This is a micro-optimization that doesn't change the control flow.

### P6: Batch broadcast

**File:** `src/sync-server.js`

**Fix:**
```js
// Replace the sequential broadcast loop in handleSubmit:
// OLD:
// for (const committedEvent of committedEvents) {
//   await broadcastCommitted({ originConnectionId, committedEvent });
// }

// NEW:
await broadcastCommittedBatch({
  originConnectionId: session.transport.connectionId,
  events: committedEvents,
});

// New function:
const broadcastCommittedBatch = async ({ originConnectionId, events }) => {
  if (events.length === 0) return;
  const projectId = events[0].projectId; // all events share the same projectId
  const recipientIds = projectSessions.get(projectId) ?? [];

  const tasks = [];
  for (const cid of recipientIds) {
    if (cid === originConnectionId) continue;
    const session = sessions.get(cid);
    if (!session || session.state !== "active" || session.syncInProgress) continue;

    // Send all events to this recipient as individual messages
    // (protocol doesn't support batch broadcast message yet)
    for (const event of events) {
      tasks.push(
        sendMessage(session.transport, "event_broadcast", event, {
          msgId: createServerMsgId(),
        }).catch((err) => {
          log({ event: "broadcast_failed", connectionId: cid, error: String(err) });
        })
      );
    }
  }
  await Promise.allSettled(tasks);
};
```

**Correction note:** The original proposal wrapped `Promise.allSettled` in `.catch()` — but `Promise.allSettled` never rejects, so the `.catch` would never fire. Use `.catch()` on each individual `sendMessage` instead.

### Phase 3 Summary

| Item | Impact | Lines changed |
|------|--------|:---:|
| P1: Project index | 100× broadcast lookup | Done in Phase 0 |
| P2: Batch commit | 3× fewer SQL statements | ~60 per store |
| P3: Backpressure | Bounded memory | ~25 in ws-server-bridge |
| P4: Pre-loop authz | 50× fewer authz calls | ~15 |
| P5: Canonicalization | SKIP | 0 |
| P6: Batch broadcast | Parallel sends | ~30 |

---

## Phase 4: Client FSM + Error Hierarchy

**Estimated effort:** 3-5 days
**Risk:** Medium — behavioral changes for consumers
**Dependencies:** Phase 2 (new store interface)

### Corrected Client FSM

The original proposal missed the `onEvent` callback — the PRIMARY event delivery mechanism for consumers. This must be preserved.

```ts
interface SyncClient {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;

  // Event submission
  submitEvent(input: EventInput): Promise<string>;          // Returns draft ID immediately
  submitEvents(inputs: EventInput[]): Promise<string[]>;    // Returns draft IDs immediately

  // Event notification — PRESERVED from current API
  onEvent(handler: (event: ClientEvent) => void): Unsubscribe;

  // Sync control
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;

  // Status — domain type, not raw internals
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;

  // Draft queue visibility
  getPendingDraftCount(): number;
  getPendingDrafts(): Promise<DraftItem[]>;
}
```

**CRITICAL CORRECTION:** The original proposal changed `submitEvent` to return `Promise<SubmitResult>` (which includes committed/rejected status). This is **wrong** — `submitEvent` currently returns the draft ID immediately, and the committed/rejected result arrives asynchronously via the `onEvent` callback. Changing this would fundamentally alter the latency profile. The `SubmitResult` type is used in the `onEvent` callback, not the `submitEvent` return value.

```ts
// Event types delivered via onEvent:
type ClientEvent =
  | { type: "committed"; id: string; committedId: number; serverTs?: number }
  | { type: "rejected"; id: string; reason: string; errors: Array<{ message: string }> }
  | { type: "not_processed"; id: string; reason: string; blockedById: string }
  | { type: "broadcast"; event: CommittedEvent }
  | { type: "synced" }
  | { type: "error"; error: InsiemeError };
```

### Corrected ClientStatus

The original was missing several fields and the `disconnected` state lacked a reason.

```ts
type ClientStatus = {
  state:
    | "idle"
    | "connecting"
    | "syncing"
    | "ready"
    | "submitting"
    | "reconnecting"
    | "disconnected"
    | "closed";
  // Contextual fields (present in relevant states):
  attempt?: number;                    // reconnecting: which attempt #
  nextRetryInMs?: number;              // reconnecting: static snapshot, NOT live countdown
  reason?: string;                     // disconnected: "reconnect_exhausted" | "auth_failed" | "transport_failed" | "protocol_error"
  lastError?: InsiemeError | null;     // Available in all states (null if no error)
  connectedServerLastCommittedId?: number | null;  // Server state at connect time
  activeProjectId?: string | null;     // Currently active project
};
```

**Corrections:**
1. Added `lastError` — the only way consumers know about auth failures, validation errors, etc.
2. Added `connectedServerLastCommittedId` — consumers use this to track server progress.
3. Added `activeProjectId` — useful for multi-project UI.
4. `disconnected` now has a `reason` field — distinguish reconnect exhaustion from auth failure.
5. `nextRetryInMs` is documented as a **static snapshot** taken when the status changes, NOT a live countdown timer.
6. `reason` uses string literals for disconnected state.

### Corrected 8-State FSM

```
┌──────────────────────────────────────────────────────────────┐
│ IDLE (started=false, closed=false)                           │
│ Includes "never started" and "stopped after running"        │
└──────────────┬───────────────────────────────────────────────┘
               │ start()
               ▼
       ┌──────────────┐
       │  CONNECTING  │ started=true, connected=false
       │              │ reconnectInFlight=false
       └──┬───┬───┬───┘
  success    │   │  error + reconnect enabled
(onConnected)│   └──────────────────────┐
             │                          ▼
             │              ┌─────────────────┐
             │              │ RECONNECTING    │ started=true, connected=false
             │              │                 │ reconnectInFlight=true
             │              └──┬───┬──────┬───┘
             │         success   │   │      │ exhausted
             │         ┌────────┘   │       │
             │         │            │       ▼
             │         │            │  ┌──────────────────┐
             │         │            │  │ DISCONNECTED      │ reason: reconnect_exhausted
             │         │            │  │                   │  | auth_failed
             │         │            │  └──┬────────────────┘
             │         │            │     │ stop()
             │         │            │     ▼
             │         │            │   IDLE
             ▼         │            │
      ┌──────────┐     │            │
      │ SYNCING  │◄────┘            │
      │          │                  │
      └──┬───┬───┘                  │
  sync     │   │ error/disconnect   │
  done     │   └────────────────────┘
           ▼
      ┌──────────┐
      │ READY    │  connected=true, syncInFlight=false, submitBatchInFlight=null
      └──┬───┬───┘
  submit │   │ disconnect
  events │   └──────────► RECONNECTING
          ▼
      ┌───────────┐
      │SUBMITTING │  submitBatchInFlight !== null
      └──┬───┬────┘
  success │   │ disconnect
          │   └──────────► RECONNECTING
          ▼
        READY

  ANY STATE ──── stop() ────► IDLE
  ANY STATE ──── close() ────► CLOSED (permanent)
```

**Key transitions added vs original proposal:**
- Disconnect can happen from SYNCING, READY, and SUBMITTING (not just READY)
- Auth failure / protocol version unsupported → DISCONNECTED (not RECONNECTING)
- CONNECTING → RECONNECTING on handshake failure with reconnect enabled

### Corrected Error Hierarchy

The original was missing 4 existing error codes (`rate_limited`, `message_too_large`, `server_error`, `submit_batch_too_large`) and proposed renaming `resource_closed` to `store_closed`.

```ts
class InsiemeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "InsiemeError";
    this.code = code;
    this.details = details ?? {};
  }
}

// Transport errors
class TransportError extends InsiemeError {
  declare code: "transport_disconnected" | "transport_connect_failed" | "transport_send_failed";
}

// Auth errors
class AuthError extends InsiemeError {
  declare code: "auth_failed" | "forbidden";
}

// Validation errors
class ValidationError extends InsiemeError {
  declare code: "validation_failed" | "bad_request" | "submit_batch_too_large" | "message_too_large";
}

// Sync/protocol errors
class SyncError extends InsiemeError {
  declare code: "sync_failed" | "protocol_error" | "protocolVersion_unsupported" | "rate_limited" | "server_error";
}

// Store errors — NOTE: resource_closed, NOT store_closed (preserving existing code)
class StoreError extends InsiemeError {
  declare code: "resource_closed" | "store_init_failed" | "schema_version_mismatch" | "busy_timeout" | "corrupt_history";
}

// Replay errors (new for projections)
class ReplayError extends InsiemeError {
  declare code: "replay_failed";
  declare details: {
    failedEventIndex: number;
    failedEventId: string;
    nearbyEvents: CommittedEvent[];
  };
}

// Wire reconstruction — converts server JSON error to typed error
function fromServerError(payload: { code: string; message: string; details?: Record<string, unknown> }): InsiemeError {
  const { code, message, details } = payload;
  if (code === "auth_failed" || code === "forbidden") return new AuthError(code, message, details);
  if (code === "validation_failed" || code === "bad_request" || code === "submit_batch_too_large" || code === "message_too_large") return new ValidationError(code, message, details);
  if (code === "transport_disconnected" || code === "transport_connect_failed" || code === "transport_send_failed") return new TransportError(code, message, details);
  if (code === "resource_closed") return new StoreError(code, message, details);
  return new SyncError(code || "server_error", message, details);
}
```

**Key corrections:**
1. Added missing error codes: `rate_limited`, `message_too_large`, `server_error`, `submit_batch_too_large`
2. `resource_closed` — NOT renamed to `store_closed`. Current code uses `resource_closed` via `store-errors.js`. Renaming is an unnecessary breaking change.
3. Added `fromServerError()` — reconstructs typed errors from wire format JSON. This was completely absent from the original proposal.
4. `protocolVersion_unsupported` is under `SyncError`, not `TransportError` — it's a protocol-level handshake failure.
5. Rejected events use `errors: Array<{ message: string }>` (array), not `message: string` (scalar) — matches current server response format.

### `reconnect: true` handling

```ts
// In createSyncClient, normalize reconnect config:
const reconnectConfig = typeof opts.reconnect === "boolean"
  ? { enabled: opts.reconnect }
  : opts.reconnect ?? { enabled: false };
```

### Files to create/modify

| File | Action | Lines |
|------|--------|:---:|
| `src/client-state-machine.ts` | Create | ~150 |
| `src/errors.ts` | Create | ~120 |
| `src/sync-client.ts` | Modify (use FSM, typed errors, onEvent preserved) | ~100 changed |
| `src/command-sync-session.ts` | Modify (preserve setOnlineTransport, getActor, submitEvent(s)) | ~50 changed |

### Test strategy

1. FSM unit tests: verify all transitions, including error paths (auth failure → DISCONNECTED, transport failure → RECONNECTING)
2. Test `onEvent` delivers committed/rejected/not_processed/broadcast/synced/error events
3. Test `submitEvent` returns draft ID synchronously
4. Test error reconstruction from server wire format
5. Test `reconnect: true` normalization

---

## Phase 5: Projections

**Estimated effort:** 5-7 days
**Risk:** High — new feature with complex lifecycle
**Dependencies:** Phase 4 (FSM) + Phase 2 (unified store with checkpoints)

### Architecture Decision: Views Stay in Store, Configured via Session

Validation confirmed that views should remain in the store (not extracted to the session). The store deeply integrates with `materialized-view-runtime.js` for checkpoint I/O, event wiring, and lifecycle management. The session acts as a **facade** — it passes view definitions to the store and delegates view methods.

### Corrected ViewDefinition Interface

The original proposal had wrong `reduce` signature, wrong checkpoint modes, missing `matchPartition`, and missing `initialState` partition argument.

```ts
interface ViewDefinition {
  name: string;
  version?: string; // defaults to "1"

  // Reduce function — receives destructured object, NOT positional args
  reduce: (ctx: { state: unknown; event: object; partition: string }) => unknown;
  // Note: returning undefined from reduce means "no change" — state is preserved

  // Initial state — can be a value (cloned) or a factory that receives partition
  initialState?: unknown | ((partition: string) => unknown);

  // Partition matching — primary mechanism for multi-partition views
  matchPartition?: (ctx: {
    loadedPartition: string;
    eventPartition: string;
    event: object;
  }) => boolean;

  // Checkpoint policy — uses ACTUAL modes, not invented ones
  checkpoint?: {
    mode: "immediate" | "manual" | "debounce" | "interval";
    debounceMs?: number;     // for "debounce" mode (default 250)
    intervalMs?: number;     // for "interval" mode (default 1000)
    maxDirtyEvents?: number; // optional threshold for all modes
    meta?: (ctx: {
      viewName: string;
      partition: string;
      lastCommittedId: number;
    }) => Record<string, unknown>; // Dynamic metadata at save time
  };

  // partitionPattern — sugar that compiles to matchPartition
  partitionPattern?: string | {
    template: string; // e.g., "scene-{sceneId}"
    extract: (event: CommittedEvent) => string[]; // derive partition(s) from event
    autoAdopt?: boolean; // auto-create hot entry on first matching event
    pruneCondition?: (state: unknown) => boolean; // when is a partition "dead"?
  };
}
```

**Key corrections:**

| Original proposal | Corrected | Why |
|---|---|---|
| `reduce: (state, event) => unknown` | `reduce: ({ state, event, partition }) => unknown` | Actual runtime passes destructured object with partition |
| `initialState?: () => unknown` | `initialState?: unknown \| ((partition: string) => unknown)` | Factory receives partition argument for multi-partition views |
| Checkpoint modes: `"off" \| "every" \| "threshold"` | `"immediate" \| "manual" \| "debounce" \| "interval"` | Original modes don't exist. These are the actual modes. |
| `partitionPattern: string` | `partitionPattern: string \| { template, extract, autoAdopt?, pruneCondition? }` | String template is insufficient. Needs extract function for deriving partitions from events. |
| Missing `matchPartition` | Added | The primary multi-partition mechanism. partitionPattern is sugar that generates a matchPartition. |
| `checkpoint.meta?: () => Record<string, unknown>` | `meta?: (ctx: { viewName, partition, lastCommittedId }) => Record<string, unknown>` | Metadata is dynamic — needs context about the view/partition being saved. |

### Corrected CommandSyncSession Interface

The original removed several essential methods. All preserved here.

```ts
interface CommandSyncSession {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>; // calls flushViews() before closing

  // Command submission
  submitCommand(command: Command): Promise<CommandResult>;
  submitCommands(commands: Command[]): Promise<CommandResult[]>;

  // Event submission (preserved from current API)
  submitEvent(input: EventInput): Promise<string>;
  submitEvents(inputs: EventInput[]): Promise<string[]>;

  // Sync control (preserved from current API)
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;

  // Offline-first (preserved — CRITICAL for offline consumers)
  setOnlineTransport(transport: Transport): Promise<void>;

  // Identity (preserved from current API)
  getActor(): Actor;

  // Status
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;

  // Draft queue
  getPendingDraftCount(): number;

  // Projection management
  getView(name: string, partition: string): Promise<ProjectionValue | undefined>;
  subscribeView(name: string, partition: string, onChange: (value: ViewUpdate) => void): Unsubscribe;
  evictView(name: string, partition: string): Promise<void>;    // ← was MISSING
  invalidateView(name: string, partition: string): Promise<void>; // ← was MISSING
  flushViews(): Promise<void>;                                    // ← was MISSING

  // Error state
  getLastError(): SessionError | null;
  clearLastError(): void;

  // Event callback (preserved from current API)
  onEvent?: (event: ClientEvent) => void;
}
```

### Session creation signature

```ts
function createCommandSyncSession({
  // Connection
  token: string;
  actor: { clientId: string; userId?: string }; // NOTE: userId is still required by current code
  projectId: string;
  transport?: Transport;
  store?: ClientStore;

  // Command mapping
  mapCommandToSyncEvent: (command: Command) => SyncEvent;
  mapCommittedToCommand: (event: CommittedEvent) => Command | null;

  // View definitions — passed through to store's materialized view runtime
  views?: ViewDefinition[];

  // Callbacks
  onCommandCommitted?: (info: { command: Command; event: CommittedEvent; isLocal: boolean }) => void;
  onStatusChange?: (status: ClientStatus) => void;
  onViewUpdate?: (update: { viewName: string; partition: string; value: unknown }) => void;
  onError?: (error: SessionError) => void;

  // Lifecycle
  reconnect?: boolean | ReconnectPolicy;
  logger?: Logger;
  schemaVersion?: string; // preserved — not removed
}): CommandSyncSession;
```

### Checkpoint schema changes

Adding `meta` to checkpoints requires schema changes:

1. Add `meta` column to SQLite/IndexedDB store schemas
2. Add `meta` to `CheckpointData` type
3. Return `meta` from `loadCheckpoint`
4. Pass `meta` through in `saveCheckpoint`

### Version mismatch handling

The runtime already handles version mismatches by deleting the checkpoint and replaying from scratch. This behavior must be preserved. When `checkpoint.viewVersion !== definition.version`, delete checkpoint and replay.

### Close-time flush

The session's `close()` method must flush views before closing, matching current store behavior:

```ts
async close() {
  await this.store.flushMaterializedViews();
  await this.syncClient.close();
}
```

### Files to create/modify

| File | Action | Lines |
|------|--------|:---:|
| `src/command-sync-session.ts` | Modify (add views, preserve all methods) | ~100 changed |
| `src/store-core/client-store-core.ts` | Modify (add meta to checkpoint handling) | ~20 changed |
| `src/adapters/*.ts` | Modify (add meta column to checkpoint schema) | ~10 each |

### Test strategy

1. Unit test: view definition with reduce, verify state transitions
2. Integration test: session with views, verify getView/subscribeView work
3. Test matchPartition with multi-partition scenarios
4. Test checkpoint save/load with meta
5. Test version mismatch → checkpoint deletion → replay
6. Test flush-on-close
7. Test `partitionPattern` sugar compiles to correct `matchPartition`
8. Verify `reduce` returning `undefined` preserves state

---

## Phase 6: Scalability (Optional)

**Estimated effort:** 10-15 days
**Risk:** High — new infrastructure dependencies
**Dependencies:** Phase 3

This phase is for production deployments needing >10K concurrent connections. It can be deferred.

### Layer 1: Single-server optimizations (Phases 0-3 cover this)

### Layer 2: Redis Pub/Sub broadcast bus

**File:** `src/broadcast-bus.ts` (new), `src/redis-broadcast-bus.ts` (new)

```ts
interface BroadcastBus {
  publish(channel: string, event: CommittedEvent): Promise<void>;
  subscribe(channel: string, handler: (event: CommittedEvent) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}
```

### Layer 3: Store sharding

Per-project database files or LibSQL namespaces.

### Layer 4: Observability

- `getStats()` on sync server
- `activeConnections` from ws-server-runtime (already tracked)
- `activeProjects` from `projectSessions` index (free from Phase 0)
- `totalCommittedEvents` as an incrementing gauge (not a COUNT query)

---

## What NOT to Do

These are mistakes found during validation. Do NOT do these things:

### ❌ 1. Don't defer canonicalization before the dedup check (P5)

The proposal suggested checking for duplicates first, then canonicalizing only on insert. This **breaks dedup payload verification**. The server uses the canonical form to compare the submitted event's payload against the existing event's payload. If the comparison key is missing, payload mismatches go undetected.

**Do instead:** Optimize `canonicalizeSubmitItem` itself (memoize, cache) but always run it before the dedup check.

### ❌ 2. Don't use `ws.once("drain")` for WebSocket backpressure (P3)

The `ws` library does **NOT** emit a `drain` event. `ws.once("drain", resolve)` will hang forever.

**Do instead:** Use `ws.send(data, callback)` for the critical-message wait path, or check `ws.bufferedAmount` and drop.

### ❌ 3. Don't rename `resource_closed` to `store_closed`

The error code `resource_closed` is used throughout `store-errors.js` and consumer code. Renaming is an unnecessary breaking change for zero benefit.

### ❌ 4. Don't change `submitEvent` to return `Promise<SubmitResult>` instead of `Promise<string>`

`submitEvent` currently returns the draft ID immediately. The committed/rejected result arrives asynchronously via the `onEvent` callback. Changing this to block until the server responds would fundamentally change the latency profile and error handling model.

**Do instead:** Keep `submitEvent → Promise<string>` and deliver results via `onEvent`.

### ❌ 5. Don't remove `onEvent` from SyncClient

`onEvent` is the primary event delivery mechanism. Consumers receive committed, rejected, not_processed, broadcast, synced, and error events through this callback. `onStatusChange` only covers lifecycle, not domain events.

### ❌ 6. Don't remove `emitCurrent` from `subscribeMaterializedView`

All stores pass `emitCurrent` through to the runtime. Consumers pass `emitCurrent: false` to skip the initial emission. Dropping this parameter breaks those consumers.

### ❌ 7. Don't absorb `persisted-cursor-client-store` into the core

It's a decorator pattern that wraps any store. Absorbing it would mean every store always has external cursor persistence. Keep it as a decorator.

### ❌ 8. Don't use `pushRejected` for store errors in F2 fix

`pushRejected` sets `blockedById`, which causes ALL subsequent events in the batch to become `not_processed`. Store errors should not block subsequent events — only validation failures should block.

**Do instead:** Push a result directly without `blockedById`.

### ❌ 9. Don't use invented checkpoint modes

The proposal invented `"off"`, `"every"`, and `"threshold"` modes. The actual modes are `"immediate"`, `"manual"`, `"debounce"`, and `"interval"`. Use the real ones.

### ❌ 10. Don't put TypeScript last

TypeScript must come first (Phase 1, after server bug fixes). Writing typed interfaces first catches type errors in all subsequent phases. Converting at the end means all intermediate code is untyped.

### ❌ 11. Don't change `listCommittedAfter` from object params to positional params

All stores use `{ sinceCommittedId, limit }` object destructuring. Changing to positional `(sinceCommittedId, limit)` breaks consumers.

### ❌ 12. Don't change the `reduce` signature to positional args

The actual runtime calls `reduce({ state, event, partition })` with a destructured object. The proposal's `reduce(state, event)` is wrong.

### ❌ 13. Don't remove `setOnlineTransport`, `getActor`, `submitEvent(s)`, `syncNow`, `flushDrafts` from CommandSyncSession

These are all current public methods used by consumers. The proposal accidentally omitted them.

### ❌ 14. Don't use both `.catch()` and `Promise.allSettled` redundantly

`Promise.allSettled` never rejects. Wrapping it in `.catch()` does nothing. Use one or the other.

### ❌ 15. Don't implement `deleteDrafts(ids[])` as a batch

No store has batch draft deletion. Drafts are always deleted one at a time by ID. The adapter should have `deleteDraft(id: string)`.

---

## Corrected Interface Reference

### StorageAdapter (12 methods)

```ts
interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  insertDrafts(items: DraftInput[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftRow[]>;
  deleteDraft(id: string): Promise<void>;
  insertCommittedEvent(event: CommittedInput): Promise<{ inserted: boolean }>;
  getCommittedById(id: string): Promise<CommittedRow | null>;
  listCommittedAfter(sinceCommittedId: number, limit: number): Promise<CommittedRow[]>;
  getMaxCommittedId(): Promise<number>;
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;
  loadCheckpoint?(viewName: string, partition: string): Promise<CheckpointData | undefined>;
  saveCheckpoint?(checkpoint: SaveCheckpointInput): Promise<void>;
  deleteCheckpoint?(viewName: string, partition: string): Promise<void>;
}
```

### ClientStore (20+ methods including aliases)

```ts
interface ClientStore {
  init(): Promise<void>;
  close(): Promise<void>;
  insertDraft(item: DraftItem): Promise<void>;
  insertDrafts(items: DraftItem[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftItem[]>;
  listDraftsOrdered(): Promise<DraftItem[]>;
  applySubmitResult(result: SubmitResult): Promise<void>;
  applyCommittedBatch(batch: { events: CommittedEvent[]; nextCursor?: number }): Promise<void>;
  listCommitted(): Promise<CommittedEvent[]>;
  listCommittedAfter(opts: { sinceCommittedId?: number; limit?: number }): Promise<CommittedEvent[]>;
  loadCursor(): Promise<number>;
  getCursor(): Promise<number>;
  loadMaterializedView(query: { viewName: string; partition: string }): Promise<MaterializedViewValue>;
  subscribeMaterializedView(query: {
    viewName: string; partition: string;
    onChange: (value: ViewUpdate) => void;
    emitCurrent?: boolean;
  }): Promise<Unsubscribe>;
  evictMaterializedView(query: { viewName: string; partition: string }): Promise<void>;
  invalidateMaterializedView(query: { viewName: string; partition: string }): Promise<void>;
  flushMaterializedViews(): Promise<void>;
  getStats(): Promise<StoreStats>;
}
```

### SyncClient

```ts
interface SyncClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  submitEvent(input: EventInput): Promise<string>;
  submitEvents(inputs: EventInput[]): Promise<string[]>;
  onEvent(handler: (event: ClientEvent) => void): Unsubscribe;
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;
  getPendingDraftCount(): number;
  getPendingDrafts(): Promise<DraftItem[]>;
}
```

### ClientStatus

```ts
type ClientStatus = {
  state: "idle" | "connecting" | "syncing" | "ready" | "submitting" | "reconnecting" | "disconnected" | "closed";
  attempt?: number;
  nextRetryInMs?: number;
  reason?: "reconnect_exhausted" | "auth_failed" | "transport_failed" | "protocol_error";
  lastError?: InsiemeError | null;
  connectedServerLastCommittedId?: number | null;
  activeProjectId?: string | null;
};
```

### ViewDefinition

```ts
interface ViewDefinition {
  name: string;
  version?: string;
  reduce: (ctx: { state: unknown; event: object; partition: string }) => unknown;
  initialState?: unknown | ((partition: string) => unknown);
  matchPartition?: (ctx: { loadedPartition: string; eventPartition: string; event: object }) => boolean;
  checkpoint?: {
    mode: "immediate" | "manual" | "debounce" | "interval";
    debounceMs?: number;
    intervalMs?: number;
    maxDirtyEvents?: number;
    meta?: (ctx: { viewName: string; partition: string; lastCommittedId: number }) => Record<string, unknown>;
  };
  partitionPattern?: string | {
    template: string;
    extract: (event: CommittedEvent) => string[];
    autoAdopt?: boolean;
    pruneCondition?: (state: unknown) => boolean;
  };
}
```

### CommandSyncSession

```ts
interface CommandSyncSession {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  submitCommand(command: Command): Promise<CommandResult>;
  submitCommands(commands: Command[]): Promise<CommandResult[]>;
  submitEvent(input: EventInput): Promise<string>;
  submitEvents(inputs: EventInput[]): Promise<string[]>;
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;
  setOnlineTransport(transport: Transport): Promise<void>;
  getActor(): Actor;
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;
  getPendingDraftCount(): number;
  getView(name: string, partition: string): Promise<ProjectionValue | undefined>;
  subscribeView(name: string, partition: string, onChange: (value: ViewUpdate) => void): Unsubscribe;
  evictView(name: string, partition: string): Promise<void>;
  invalidateView(name: string, partition: string): Promise<void>;
  flushViews(): Promise<void>;
  getLastError(): SessionError | null;
  clearLastError(): void;
}
```

### Error Hierarchy

```ts
InsiemeError (base)
├── TransportError     (transport_disconnected, transport_connect_failed, transport_send_failed)
├── AuthError          (auth_failed, forbidden)
├── ValidationError    (validation_failed, bad_request, submit_batch_too_large, message_too_large)
├── SyncError          (sync_failed, protocol_error, protocolVersion_unsupported, rate_limited, server_error)
├── StoreError         (resource_closed, store_init_failed, schema_version_mismatch, busy_timeout, corrupt_history)
└── ReplayError        (replay_failed)
```

Plus `fromServerError()` for wire reconstruction.

### Transport

```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  setLogger?(logger: Logger): void;
}
```

---

## Summary of All 15 Critical/Significant Validation Fixes

| # | Issue | Source | Fix in this plan |
|---|-------|--------|-----------------|
| 1 | `onEvent` callback missing from SyncClient | VALIDATION-2 | Preserved in §Phase 4 |
| 2 | P3 backpressure fix wrong (`ws` has no `drain` event) | VALIDATION-3 | Fixed with `ws.send(data, callback)` in §Phase 3 |
| 3 | P5 canonicalization fix breaks dedup comparison | VALIDATION-3 | Skipped — §What NOT to Do #1 |
| 4 | Wire error reconstruction unaddressed | VALIDATION-5 | Added `fromServerError()` in §Phase 4 |
| 5 | `reduce` signature wrong in projections | VALIDATION-4 | Corrected to `({ state, event, partition })` in §Phase 5 |
| 6 | F2 fix blocks subsequent events via `blockedById` | VALIDATION-3 | Fixed: push result directly, don't use `pushRejected` in §Phase 0 |
| 7 | 5 public store methods missing from ClientStore | VALIDATION-1 | All added: getCursor, listDraftsOrdered, evictMV, invalidateMV, emitCurrent in §Phase 2 |
| 8 | Schema management unaddressed in adapter | VALIDATION-1 | Added `schema-manager.ts` in §Phase 2 |
| 9 | Persisted cursor store should stay as decorator | VALIDATION-1 | Preserved as decorator in §Phase 2 |
| 10 | Checkpoint modes wrong in projections | VALIDATION-4 | Corrected to immediate/manual/debounce/interval in §Phase 5 |
| 11 | Line count estimates optimistic by 10-20% | VALIDATION-1 | Realistic estimates in §Phase 2 |
| 12 | `submitEvent` return type change breaks consumers | VALIDATION-2 | Preserved as `Promise<string>` in §Phase 4 |
| 13 | `resource_closed` → `store_closed` rename | VALIDATION-5 | Kept as `resource_closed` in §Phase 4 |
| 14 | `syncInProgress` stuck forever (F5) | VALIDATION-3 | Added `finally` reset in §Phase 0 |
| 15 | No max batch size on server | VALIDATION-3 | Added batch size limit in §Phase 0 |

---

## Total Effort Estimate

| Phase | Days | Dependencies |
|-------|:----:|-------------|
| Phase 0: Server bug fixes | 2-3 | None |
| Phase 1: TypeScript | 2-3 | None |
| Phase 2: Storage unification | 5-7 | Phase 1 |
| Phase 3: Server performance | 3-5 | Phase 2 |
| Phase 4: Client FSM + errors | 3-5 | Phase 2 |
| Phase 5: Projections | 5-7 | Phases 2 + 4 |
| Phase 6: Scalability | 10-15 | Phase 3 |
| **Total (Phases 0-5)** | **20-30** | |
| **Total (all phases)** | **30-45** | |
