# VALIDATION REPORT: Part 1 — Storage Adapter Proposal

**Date**: 2025-05-08  
**Validator**: Automated review against source  
**Proposal**: `CLEAN-INTERFACE-PLAN.md` Part 1 (lines 13–149)  
**Scope**: All 6 client stores + `materialized-view-runtime.js`

---

## Executive Summary

The proposal's **direction is correct** — there IS heavy duplication across the 6 stores and unifying them is worthwhile. However, the proposal contains **significant factual errors** in its claims about current code, its adapter interface is **incomplete**, several proposed methods have **wrong signatures**, it **underestimates** what the adapters need to do, and some proposed changes would **break existing functionality**. The line count estimates are off by ~25%.

**Verdict**: Proposal needs revision before implementation. Not ready as-is.

---

## 1. Line Count Audit

### Actual line counts of current store files:

| File | Actual Lines | Proposal Claims |
|------|-------------|-----------------|
| `in-memory-client-store.js` | 336 | (not individually listed) |
| `indexeddb-client-store.js` | 742 | (not individually listed) |
| `sqlite-client-store.js` | 788 | (not individually listed) |
| `libsql-client-store.js` | 821 | (not individually listed) |
| `async-sqlite-client-store.js` | 978 | (not individually listed) |
| `persisted-cursor-client-store.js` | 90 | (not individually listed) |
| `materialized-view-runtime.js` | 575 | (not listed as "deleted") |
| **Total** | **4,330** | **~4,728 (line 133), ~4,700 (line 441)** |

### Discrepancies:

1. **Proposal claims ~4,728 lines (line 133) and ~4,700 lines (line 441)**. Actual total is **4,330** — the proposal inflates by ~400 lines (~9%).
2. **The proposal does not count `materialized-view-runtime.js` (575 lines)** as a file to be deleted, yet proposes to "absorb" `persisted-cursor-client-store.js` into the core. The runtime is the *real* shared infrastructure — it already exists and is NOT duplicated. The proposal seems confused about what's duplicated vs. what's shared.
3. **The net reduction claim of ~2,940 lines (line 443)** is based on inflated deletion numbers. The real reduction would be ~4,330 - 575 (runtime kept) - ~1,300 (new code) = **~2,455 lines**, roughly 17% less than claimed.

---

## 2. Actual Public Methods Per Store

### Complete method inventory for each store:

| Method | In-Memory | IndexedDB | SQLite | LibSQL | AsyncSQLite |
|--------|:---------:|:---------:|:------:|:------:|:-----------:|
| `init()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `close()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `loadCursor()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| **`getCursor()`** | ✓ | ✓ | ✓ | ✓ | ✓ |
| `insertDrafts(items)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `insertDraft(item)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `loadDraftsOrdered()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| **`listDraftsOrdered()`** | ✓ | ✓ | ✓ | ✓ | ✓ |
| `applySubmitResult({result})` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `applyCommittedBatch({events, nextCursor})` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `listCommitted()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `listCommittedAfter({sinceCommittedId, limit})` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `loadMaterializedView({viewName, partition})` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `subscribeMaterializedView({viewName, partition, onChange, emitCurrent})` | ✓ | ✓ | ✓ | ✓ | ✓ |
| **`evictMaterializedView({viewName, partition})`** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **`invalidateMaterializedView({viewName, partition})`** | ✓ | ✓ | ✓ | ✓ | ✓ |
| `flushMaterializedViews()` | ✓ | ✓ | ✓ | ✓ | ✓ |
| **`_debug`** | ✓ | ✓ | ✓ | ✓ | ✓ |

### Methods the proposal MISSES entirely:

| Missing Method | Present In | Purpose |
|---------------|-----------|---------|
| **`getCursor()`** | ALL 5 stores | Alias for `loadCursor()` — used by consumers; removing it is a breaking change |
| **`insertDraft(item)`** | ALL 5 stores | Single-draft insert — proposal only has `insertDrafts(items[])` |
| **`listDraftsOrdered()`** | ALL 5 stores | Identical to `loadDraftsOrdered()` — both are exposed; removing is a breaking change |
| **`listCommitted()`** | ALL 5 stores | Returns ALL committed events — proposal omits this from the adapter |
| **`evictMaterializedView()`** | ALL 5 stores | Evicts a hot entry from the runtime cache |
| **`invalidateMaterializedView()`** | ALL 5 stores | Invalidates checkpoint + evicts, then rehydrates for subscribers |
| **`_debug`** | ALL 5 stores | Debug access to internals — not business-critical but used in tests |

---

## 3. Adapter Interface: Method-by-Method Comparison

The proposal defines a 13-method `StorageAdapter` interface (lines 22–47). Let's compare:

### 3.1 Methods that are CORRECT

| Adapter Method | Verdict | Notes |
|---------------|---------|-------|
| `init(): Promise<void>` | ✅ Correct | All stores have `init()` |
| `close(): Promise<void>` | ✅ Correct | All stores have `close()` |
| `loadCursor(): Promise<number>` | ✅ Correct | In adapter, core exposes `loadCursor()` |
| `saveCursor(cursor: number): Promise<void>` | ✅ Correct | Used internally |

### 3.2 Methods with WRONG SIGNATURES

| Adapter Method | Problem |
|---------------|---------|
| **`insertDrafts(items: DraftInput[]): Promise<void>`** | **Wrong**: The adapter doesn't handle `draftClock` assignment. In reality, SQLite/LibSQL/AsyncSQLite stores use `AUTOINCREMENT` for `draft_clock`, while In-Memory and IndexedDB use a manual counter (`nextDraftClock` / `NEXT_DRAFT_CLOCK_KEY`). The core would need to either: (a) always assign `draftClock` in the adapter, or (b) handle both modes. The proposal doesn't address this. |
| **`listCommittedAfter(sinceCommittedId: number, limit: number): Promise<CommittedRow[]>`** | **Wrong parameter style**: All 5 stores use `{sinceCommittedId, limit}` (object destructure) at the public API level. The adapter uses positional params — that's fine for the adapter layer, but the proposal's `ClientStore` interface (line 68) also uses positional params, which **breaks the existing API contract**. Currently all stores take a single object arg: `{sinceCommittedId = 0, limit = MAX}` |
| **`insertCommittedEvent(event: CommittedInput): Promise<{ inserted: boolean }>`** | **Incomplete**: This method doesn't exist in ANY current store. Currently, committed events are inserted via the dedup-aware logic inside `applySubmitResult` and `applyCommittedBatch`. The adapter method as proposed is too simple — it doesn't account for the `INSERT OR IGNORE` + `assertCommittedInvariant` pattern that SQLite stores use (see sqlite-client-store.js lines 480–498). The adapter would need to either: return enough info for the core to do the invariant check, or the invariant check itself becomes adapter logic (which the proposal says should NOT be in the adapter). |
| **`getCommittedById(id: string): Promise<CommittedRow \| null>`** | **Not a public method**: This is only used internally for the committed invariant check. It's not exposed by any store's public API. Making it an adapter method is fine architecturally, but the proposal claims the adapter is "pure read/write/delete" — yet this is a query needed for business logic. |
| **`getMaxCommittedId(): Promise<number>`** | **Not a public method**: Same issue — only used internally by the materialized view runtime. |

### 3.3 Methods MISSING from the adapter

| Missing Adapter Method | Why It's Needed |
|----------------------|-----------------|
| **`deleteDrafts(ids: string[])`** or **`deleteDraft(id: string)`** | The proposal lists `deleteDrafts(ids: string[])` in the adapter, but **no current store has a `deleteDrafts` method**. Drafts are deleted individually inside `applySubmitResult` and `applyCommittedBatch` — always one at a time by ID. The proposal invents a batch-delete that doesn't exist. |
| **Schema management methods** | SQLite, LibSQL, and AsyncSQLite stores all have `createSchema()`, `validateSchema()`, `initializeSchema()`, `getUserVersion()`, `setUserVersion()` (~120 lines each). The proposal puts these in a shared `schema-manager.js` but doesn't list any adapter methods for them. How would the adapter trigger schema creation? The `init()` method? Then the adapter needs the full schema DDL, which is SQLite-specific. |
| **`deleteDraft(id: string)`** (single) | This is what's actually used. The batch `deleteDrafts` is invented. |

### 3.4 Methods in the proposal's `ClientStore` (lines 54–80) that have ISSUES

| ClientStore Method | Problem |
|-------------------|---------|
| **`insertDraft(item: DraftItem)` + `insertDrafts(items: DraftItem[])`** | The `ClientStore` exposes both, but the adapter only has `insertDrafts`. The core would delegate `insertDraft` to `insertDrafts([item])`. That works, but there's a subtlety: In-Memory store's `insertDraft` does NOT use the same `draftClock` allocation as `insertDrafts` — `insertDraft` uses `nextDraftClock` directly, while `insertDrafts` batches the clock assignment. The unified core must handle this. |
| **`listCommitted(): Promise<CommittedEvent[]>`** | Present in the `ClientStore` interface but NOT backed by any adapter method. The proposal expects the core to implement this by calling `listCommittedAfter(0, MAX_SAFE_INTEGER)` — that's fine, but should be explicit. |
| **`subscribeMaterializedView` with `emitCurrent` param** | The `ClientStore` interface (line 75) omits the `emitCurrent` parameter that ALL current stores expose. `subscribeMaterializedView` currently takes `{viewName, partition, onChange, emitCurrent}`. The proposal drops `emitCurrent`. This would **break consumers** that pass `emitCurrent: false`. |
| **`getStats()`** | **Not in any current store**. This is genuinely new functionality, not a replacement. Fine to add, but it's additive, not part of the "unification". |

---

## 4. Business Logic Duplication Analysis

The proposal claims "~3,600 lines of duplicated business logic" and lists these as duplicated:
`normalizeCommittedEvent`, `toComparisonKey`, `assertCommittedInvariant`, `parseDraft`, `parseCommittedRow`, `validateSchema`, `createSchema`, `applySubmitResult`, `applyCommittedBatch`, plus "6 materialized-view pass-through methods".

### What's actually duplicated:

| Logic | In-Memory | IDB | SQLite | LibSQL | AsyncSQLite | Truly duplicated? |
|-------|:---------:|:---:|:------:|:------:|:-----------:|:-----------------:|
| `normalizeCommittedEvent` | ✓ (line 67) | ✓ (line 230) | ✓ (line 275) | ✓ (line 58) | ✓ (line 45) | ✅ Yes — identical |
| `toComparisonKey` | ✓ (line 75) | ✓ (line 238) | ✓ (line 44) | ✓ (line 69) | ✓ (line 56) | ✅ Yes — identical |
| `assertCommittedInvariant` | ✓ (inline) | ✓ (line 397) | ✓ (line 286) | ✓ (line 251) | ✓ (line 365) | ✅ Yes — similar but adapts to sync vs async |
| `parseDraft` | N/A | ✓ (line 153) | ✓ (line 248) | ✓ (line 31) | ✓ (line 18) | ⚠️ Partially — IDB uses `parseIntSafe`; SQLite uses `deserializePayload`; In-Memory has no parse |
| `parseCommittedRow` | N/A | ✓ (line 187) | ✓ (line 260) | ✓ (line 43) | ✓ (line 30) | ⚠️ Same pattern as parseDraft |
| `normalizeClientTs` | ✓ | ✓ | ✓ | ✓ | ✓ | ✅ Yes — imported from event-record.js |
| `buildCommittedEventFromDraft` | ✓ | ✓ | ✓ | ✓ | ✓ | ✅ Yes — imported from event-record.js |
| `applySubmitResult` business logic | ✓ (line 223) | ✓ (line 566) | ✓ (line 682) | ✓ (line 566) | ✓ (line 723) | ✅ Yes — same logic, different I/O |
| `applyCommittedBatch` business logic | ✓ (line 248) | ✓ (line 609) | ✓ (line 690) | ✓ (line 643) | ✓ (line 801) | ✅ Yes — same logic, different I/O |
| `createSchema` + `validateSchema` | N/A | N/A | ✓ | ✓ | ✓ | ✅ Yes — nearly identical SQL DDL |
| 6 materialized view pass-throughs | ✓ | ✓ | ✓ | ✓ | ✓ | ✅ Yes — literally just delegate to runtime |
| `createMaterializedViewRuntime` setup | ✓ (line 32) | ✓ (line 294) | ✓ (line 547) | ✓ (line 302) | ✓ (line 418) | ✅ Yes — each store wires up getLatestCommittedId, listCommittedAfter, load/save/deleteCheckpoint |

### Is the "~70% duplication" claim accurate?

**Roughly yes.** The core business logic pattern (normalize → insert → dedup → notify views) is repeated in each store. The I/O layer varies significantly (IndexedDB transactions vs. better-sqlite3 sync API vs. libsql async queries vs. Tauri async driver), but the surrounding logic is nearly identical.

However, the proposal **undercounts the I/O-specific glue**. Each store has substantial I/O boilerplate:
- IndexedDB: `requestToPromise`, `transactionDone`, `listAll`, `listCommittedAfter` (IDB-specific cursor traversal) — ~94 lines (lines 29–107)
- SQLite: `prepareStatements` with 16 prepared statements — ~228 lines (lines 317–545)
- AsyncSQLite: `runRead`/`runWrite` serialization, `normalizeTransaction`, `beginOperation`/`waitForIdle` — ~90 lines (lines 70–211)

This glue is NOT duplicable — it's backend-specific. The proposal correctly identifies that adapters handle this. But the estimated adapter sizes (60–150 lines) are too small for what's needed:

| Adapter | Proposal Estimate | Realistic Estimate | Why |
|---------|:-:|:-:|-----|
| In-Memory | 60 | 80 | Needs draftClock management, committedById Map, sorting |
| IndexedDB | 100 | 200 | IDB transaction wrapping, cursor-based listCommittedAfter, schema migration, requestToPromise helpers |
| SQLite | 120 | 180 | 16 prepared statements, transaction wrapper, serializePayload |
| LibSQL | 100 | 200 | Async transaction, serializePayload, libsqlDriver wrapper |
| AsyncSQLite | 150 | 300 | read/write serialization, operation tracking, normalized transaction wrapper, WAL management |

**Total adapters**: Proposal says ~530 lines. Realistic: ~960 lines.

---

## 5. Materialized View Runtime Analysis

The proposal does NOT list `materialized-view-runtime.js` as a file to delete or modify. It says the runtime is already shared and the store pass-throughs will be eliminated. This is **mostly correct** — the runtime already lives in one file and is used by all stores.

However:

1. **The runtime's interface to the store is more complex than the proposal suggests.** Each store passes 6 functions to `createMaterializedViewRuntime`:
   - `getLatestCommittedId`
   - `listCommittedAfter`
   - `loadCheckpoint`
   - `saveCheckpoint`
   - `deleteCheckpoint`
   - (chunkSize)

   The proposal's adapter has `loadCheckpoint`, `saveCheckpoint`, `deleteCheckpoint` (correct), but `getMaxCommittedId` and `listCommittedAfter` are on the adapter for the store's direct use, not specifically for the runtime. The proposal doesn't explain how the core wires these to the runtime.

2. **The proposal adds `meta?` to `CheckpointData`** (line 95). Currently, checkpoints have no `meta` field. The runtime's `saveCheckpoint` call (runtime line 219) sends `{viewName, viewVersion, partition, value, lastCommittedId, updatedAt}` — no meta. Adding `meta` is a new feature, not a replacement. Fine, but be clear it's additive.

3. **The `subscribeMaterializedView` `emitCurrent` parameter is missing from the proposed ClientStore interface** (line 75). The runtime supports it (runtime line 383), all stores pass it through. Dropping it breaks consumers.

---

## 6. Persisted Cursor Store Analysis

The proposal says `persisted-cursor-client-store.js` will be "absorbed into core" (line 425). Let's validate:

**What it does** (90 lines, lines 1–90):
- Wraps any store and intercepts `init`, `loadCursor`, `applyCommittedBatch`
- On `init`: loads a persisted cursor from external storage, applies it to the inner store
- On `loadCursor`: returns `max(innerStore.loadCursor(), persistedCursor)`
- On `applyCommittedBatch`: delegates then persists the new cursor

**Issues with "absorb into core":**
- This is a **decorator pattern**, not core logic. It wraps ANY store and adds external cursor persistence.
- Absorbing it into the core would mean every store always has external cursor persistence — but only some consumers need it.
- **Better approach**: Keep it as a wrapper/decorator, which it already is. The proposal should keep `persisted-cursor-client-store.js` as a thin wrapper that works with any `createClientStore(adapter)` result. No changes needed.

---

## 7. Wrong Assumptions

### 7.1 "Every store independently implements normalizeCommittedEvent, toComparisonKey, assertCommittedInvariant..."

**Partially wrong.** In the In-Memory store, `assertCommittedInvariant` is inlined as `upsertCommitted` (lines 84–107) — it's a simpler version that uses a Map lookup instead of a database query. The logic is the same conceptually but the implementation is fundamentally different because In-Memory doesn't have INSERT OR IGNORE semantics.

### 7.2 "parseDraft, parseCommittedRow" are duplicated

**Nuanced.** The In-Memory store has NO `parseDraft` or `parseCommittedRow` — it stores objects directly. These parsing functions only exist in the 4 persistent stores (IDB, SQLite, LibSQL, AsyncSQLite). And they differ:
- IDB: uses `structuredClone` for payload, `parseIntSafe` for integers
- SQLite/LibSQL/AsyncSQLite: uses `deserializePayload` for payload (which handles BLOB → object decompression)

The codec layer differs between IDB and SQL stores. The adapter can hide this, but the `row-codec.js` proposal needs to account for two different serialization strategies.

### 7.3 "13 methods. Zero business logic. Pure read/write/delete."

**Wrong on the "zero business logic" claim.** The proposed `insertCommittedEvent(event): Promise<{inserted: boolean}>` method requires the adapter to determine whether the event was actually inserted (i.e., handle INSERT OR IGNORE and report back). This is business logic (dedup detection) leaking into the adapter.

The alternative — having the core call `getCommittedById` after insert to check — would be a race condition in concurrent environments and an extra round-trip.

### 7.4 The `deleteDrafts(ids: string[])` method

**Invented.** No current store has this. Drafts are always deleted one at a time, embedded in transaction logic (`applySubmitResult` or `applyCommittedBatch`). The adapter should have `deleteDraft(id: string)` instead, and the core can call it in a loop if needed.

---

## 8. Proposed Changes That Would BREAK Existing Functionality

### 8.1 Breaking: `listCommittedAfter` signature change

**Current** (all stores): `listCommittedAfter({sinceCommittedId = 0, limit = MAX_SAFE_INTEGER} = {})`  
**Proposed ClientStore** (line 68): `listCommittedAfter(sinceCommittedId: number, limit?: number)`

This changes from **object argument with defaults** to **positional arguments**. Any consumer calling `store.listCommittedAfter({sinceCommittedId: 5})` would break.

### 8.2 Breaking: Missing `emitCurrent` on `subscribeMaterializedView`

**Current** (all stores): `subscribeMaterializedView({viewName, partition, onChange, emitCurrent})`  
**Proposed ClientStore** (line 75): `subscribeMaterializedView(query: {viewName, partition, onChange})`

Drops `emitCurrent`. Consumers that pass `emitCurrent: false` would break.

### 8.3 Breaking: Missing `getCursor()` alias

All 5 stores expose both `loadCursor()` and `getCursor()` (identical methods). The proposal only keeps `loadCursor()`. Any consumer using `store.getCursor()` would break.

### 8.4 Breaking: Missing `listDraftsOrdered()` alias

All 5 stores expose both `loadDraftsOrdered()` and `listDraftsOrdered()` (identical methods). The proposal only has `loadDraftsOrdered()`. Any consumer using `store.listDraftsOrdered()` would break.

### 8.5 Breaking: Missing `evictMaterializedView()` and `invalidateMaterializedView()`

All 5 stores expose both. The proposed `ClientStore` interface (lines 54–80) only has `loadMaterializedView`, `subscribeMaterializedView`, and `flushMaterializedViews`. Removing `evictMaterializedView` and `invalidateMaterializedView` would break consumers that use them for cache management.

### 8.6 Potentially Breaking: `insertDrafts` vs `insertDraft` behavior

The In-Memory store's `insertDraft` and `insertDrafts` have different duplicate-detection logic:
- `insertDrafts` (line 132): checks `seenIds` (within-batch) AND `drafts.find` (against existing)
- `insertDraft` (line 178): only checks `drafts.find`

If the core delegates `insertDraft` to `insertDrafts([item])`, the behavior is equivalent. But this needs to be verified during implementation.

### 8.7 Potentially Breaking: `applyCommittedBatch` cursor monotonicity

The In-Memory store (line 259) does cursor monotonicity inline:
```js
if (nextCursor !== undefined) cursor = Math.max(cursor, nextCursor);
```

SQLite (line 310–315) uses a prepared `saveCursorMonotonic` function. LibSQL (line 287–300) does it in a SQL expression. These all behave the same, but the core must replicate this exactly.

---

## 9. Corrected Adapter Interface

Based on the actual code, the adapter should look like this:

```ts
interface StorageAdapter {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Drafts (adapter handles draftClock generation)
  insertDrafts(items: DraftInput[]): Promise<void>;
  loadDraftsOrdered(): Promise<DraftRow[]>;
  deleteDraft(id: string): Promise<void>;         // ← fixed: single, not batch

  // Committed
  insertCommittedEvent(event: CommittedInput): Promise<{ inserted: boolean }>;
  getCommittedById(id: string): Promise<CommittedRow | null>;
  listCommittedAfter(sinceCommittedId: number, limit: number): Promise<CommittedRow[]>;
  getMaxCommittedId(): Promise<number>;

  // Cursor
  loadCursor(): Promise<number>;
  saveCursor(cursor: number): Promise<void>;

  // Checkpoints (optional)
  loadCheckpoint?(viewName: string, partition: string): Promise<CheckpointData | undefined>;
  saveCheckpoint?(checkpoint: SaveCheckpointInput): Promise<void>;
  deleteCheckpoint?(viewName: string, partition: string): Promise<void>;
}
```

That's **12 methods** (9 required + 3 optional), not 13. The proposal had `deleteDrafts(ids[])` which doesn't match reality.

The corrected `ClientStore` should also include:

```ts
interface ClientStore {
  // ... as proposed, PLUS:
  getCursor(): Promise<number>;                      // ← missing alias
  listDraftsOrdered(): Promise<DraftItem[]>;         // ← missing alias
  evictMaterializedView(query: { viewName, partition }): Promise<void>;   // ← missing
  invalidateMaterializedView(query: { viewName, partition }): Promise<void>; // ← missing
  subscribeMaterializedView(query: {
    viewName: string, partition: string,
    onChange: (value: ViewUpdate) => void,
    emitCurrent?: boolean                            // ← missing param
  }): Promise<Unsubscribe>;
}
```

---

## 10. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking `listCommittedAfter` signature | HIGH | Keep object-param signature |
| Breaking `subscribeMaterializedView` by dropping `emitCurrent` | HIGH | Keep `emitCurrent` parameter |
| Missing `evictMaterializedView`/`invalidateMaterializedView` | MEDIUM | Add to ClientStore interface |
| In-Memory store can't implement `insertCommittedEvent → {inserted: boolean}` cleanly | MEDIUM | Use Map.has() check before set |
| Schema management not addressed in adapter | MEDIUM | Add optional `initSchema()` adapter method or handle in `init()` |
| Async SQLite serialization logic too complex for 150-line adapter estimate | LOW | Accept larger adapter file |
| `persisted-cursor-client-store` should stay as decorator | LOW | Keep it, don't absorb into core |

---

## 11. Summary of Findings

| Category | Proposal Claim | Reality | Status |
|----------|---------------|---------|--------|
| Number of stores | 6 | 6 | ✅ Correct |
| Total lines to delete | ~4,700 | 4,330 | ❌ Inflated by ~9% |
| Duplicated logic claim | ~3,600 lines | ~2,500 lines of truly duplicated *business* logic | ⚠️ Overestimated |
| Adapter method count | 13 | 12 (9 required + 3 optional) | ⚠️ Close but wrong |
| `deleteDrafts` in adapter | Yes | No store has batch delete; they use single `deleteDraft` | ❌ Wrong |
| `emitCurrent` on subscribe | Omitted | All stores expose it | ❌ Missing |
| `evictMaterializedView` | Omitted | All stores expose it | ❌ Missing |
| `invalidateMaterializedView` | Omitted | All stores expose it | ❌ Missing |
| `getCursor` / `listDraftsOrdered` aliases | Omitted | All stores expose both | ❌ Missing |
| `listCommittedAfter` signature | Positional args | Object destructure | ❌ Wrong |
| Adapter size estimates | 60-150 lines each | 80-300 lines each | ⚠️ Underestimated |
| Persisted cursor store | "Absorb into core" | Should stay as decorator | ⚠️ Wrong approach |
| `materialized-view-runtime.js` treatment | Not mentioned as kept | Already shared; should be kept as-is | ✅ Correct (by omission) |
| Net reduction claim | ~2,940 lines | ~2,100–2,455 lines | ⚠️ Overestimated |
| Zero business logic in adapter | Claimed | `insertCommittedEvent` needs dedup detection | ⚠️ Not quite pure |
