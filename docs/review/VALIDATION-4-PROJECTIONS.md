# Validation Report: Part 3 — Command Session First-Class Projections

**Date:** 2026-05-08  
**Validated against:** `src/command-sync-session.js` (279 lines), `src/materialized-view-runtime.js` (575 lines), `src/materialized-view.js` (178 lines), `src/reducer.js` (68 lines)  
**Proposal:** CLEAN-INTERFACE-PLAN.md Part 3

---

## 1. Executive Summary

The proposal correctly identifies that `command-sync-session.js` has **zero view management** today — no view definitions, no `getView()`, no `subscribeView()`, no checkpoint integration. Views are entirely the store's responsibility. The proposal to make views first-class on the session is sound in direction but has several **incomplete assumptions, wrong interface details, and missing features** relative to the actual runtime.

**Verdict: Direction correct, interface details need revision before implementation.**

---

## 2. Claim Validation

### 2.1 Claim: "command-sync-session has no view management" ✅ CORRECT

**Evidence from source:**

`command-sync-session.js` (279 lines) creates an `in-memory` store with **empty materialized views**:

```js
// line 74-78
const runtimeStore =
  store ||
  createInMemoryClientStore({
    materializedViews: [],  // ← always empty if no store provided
  });
```

The returned session object exposes exactly these methods (lines 223-278):
- `start()`, `stop()`, `close()`
- `submitCommands()`, `submitEvents()`, `submitEvent()`
- `syncNow()`, `flushDrafts()`
- `setOnlineTransport()`
- `getActor()`, `getStatus()`, `getLastError()`, `clearLastError()`

**No view methods at all.** The session doesn't even expose the store's view methods (loadMaterializedView, subscribeMaterializedView, evictMaterializedView, invalidateMaterializedView, flushMaterializedViews).

**Consumer must either:**
1. Access the store directly to call view methods, OR
2. Create their own materialized view runtime and wire it to events manually

This confirms the proposal's core problem statement.

### 2.2 Claim: "3,932 lines → 50 lines" ⚠️ OVERLY OPTIMISTIC

The breakdown:
| Component | Claimed Lines | Assessment |
|---|---|---|
| projection.js | ~2,492 | Plausible (full replay engine) |
| replay error recovery | ~250 | Plausible |
| multi-partition management | ~300 | Plausible |
| checkpoint envelope | ~170 | Plausible |
| boilerplate wrappers | ~370 | Plausible |
| SQLite workarounds | ~350 | Addressed by Part 1 (storage), not Part 3 |
| **Total** | **~3,932** | |

**Issue:** The 350 lines of SQLite workarounds are addressed by Part 1 (Storage unification), not Part 3 (Projections). Double-counting inflates the Part 3 savings by ~350 lines.

**Realistic reduction for Part 3 alone:** ~3,582 lines → probably ~100-150 lines of config, not 50. The consumer will still need:
- View reducer logic (cannot be eliminated, only relocated)
- Custom partition matching logic beyond simple patterns
- App-specific error handling for reduce failures

**Revised estimate: ~3,582 → ~100-150 lines.** Still excellent, but "50 lines" is marketing.

### 2.3 Claim: Views are "declared at session creation" ⚠️ NEEDS DESIGN WORK

The proposal says views are declared via `views?: ViewDefinition[]` at session creation. This is fine for **single-partition static views**. But the actual `materialized-view-runtime.js` supports **dynamic multi-partition views** where partitions are discovered at runtime.

The current runtime architecture (lines 62-67):
```js
const hotEntriesByView = new Map(
  (normalizedDefinitions || []).map((definition) => [definition.name, new Map()]),
);
```

Each view has a `Map<string, HotEntry>` for partitions. Partitions are created lazily on first `loadMaterializedView` or `subscribeMaterializedView` call. The proposal's `partitionPattern` doesn't account for how partitions are **discovered** (they emerge from event data, not config).

---

## 3. ViewDefinition Interface — Discrepancies

### 3.1 Proposed vs Actual `reduce` Signature ❌ MISMATCH

**Proposal says:**
```ts
reduce: (state: unknown, event: CommittedEvent) => unknown;
```

**Actual runtime calls:**
```js
// materialized-view.js line 158
definition.reduce({
  state,
  event: toReducerEvent(event),
  partition,
});
```

The actual `reduce` receives `{ state, event, partition }` — a **destructured object**, not positional args. And `event` is wrapped via `toReducerEvent()` which adds an `event` envelope:
```js
// materialized-view.js lines 136-143
return {
  ...event,
  event: {
    type: event.type,
    payload: event.payload,
  },
};
```

**Impact:** The proposal's `reduce: (state, event) => unknown` signature is wrong. It should be `reduce: ({ state, event, partition }) => unknown`.

### 3.2 Missing `matchPartition` ❌ SIGNIFICANT OMISSION

The actual view definition schema (from `normalizeMaterializedViewDefinitions`, line 120-124):
```js
matchesPartition:
  typeof entry.matchPartition === "function"
    ? entry.matchPartition
    : ({ loadedPartition, eventPartition }) =>
        loadedPartition === eventPartition,
```

The current system uses `matchPartition(loadedPartition, eventPartition, event)` to decide which hot entries should process an event. This is how multi-partition views work: a single event can update multiple partitions if `matchPartition` returns true for each.

**The proposal's `partitionPattern` replaces this with a string template**, but `matchPartition` is far more flexible — it receives the full event object and can match on arbitrary event fields.

**What `partitionPattern` misses:**
- Events that belong to **multiple** partitions simultaneously
- Partition matching based on event payload data, not just partition string
- Cross-partition aggregation views

**Recommendation:** Keep `matchPartition` as the primary mechanism. `partitionPattern` can be sugar that generates a `matchPartition` function, but should not replace it.

### 3.3 Missing `initialState` Factory Nuance ⚠️

The proposal offers `initialState?: () => unknown`. The actual implementation (materialized-view.js lines 6-17) supports three modes:
1. `initialState` is a function → called with `(partition)` argument
2. `initialState` is a value → `structuredClone`'d each time
3. `initialState` is undefined → returns `undefined`

The **partition argument** to `initialState` is important for multi-partition views where initial state varies per partition. The proposal's `initialState?: () => unknown` misses this.

**Correct signature:** `initialState?: unknown | ((partition: string) => unknown)`

### 3.4 Checkpoint Modes ❌ WRONG MODES

**Proposal says:**
```ts
checkpoint?: {
  mode: "off" | "every" | "threshold";
  every?: number;
  debounceMs?: number;
  meta?: () => Record<string, unknown>;
};
```

**Actual modes** (materialized-view.js lines 24-68):
```js
mode: "immediate" | "manual" | "debounce" | "interval"
```

With parameters:
- `debounceMs` (for debounce mode, default 250)
- `intervalMs` (for interval mode, default 1000)
- `maxDirtyEvents` (optional threshold for all modes)

**The proposal invents modes that don't exist** (`"off"`, `"every"`, `"threshold"`) and omits the actual modes (`"immediate"`, `"manual"`, `"debounce"`, `"interval"`).

### 3.5 Checkpoint `meta` — Current State ✅

The current `saveCheckpoint` call (materialized-view-runtime.js lines 217-228) does **not** include a `meta` field:
```js
await saveCheckpoint({
  viewName: definition.name,
  viewVersion: definition.version,
  partition,
  value: entry.state,
  lastCommittedId: entry.lastCommittedId,
  updatedAt: entry.updatedAt || now(),
});
```

The proposal's `checkpoint.meta` is genuinely new. The consumer's pain point (wrapping values in envelopes) is real — see consumer-pain-points.md §3.1.

However, the proposal's `meta?: () => Record<string, unknown>` is a **static factory**. The consumer's use case is dynamic — they inject `historyStats` at save time:
```js
historyStats: await loadRepositoryHistoryStats(),
```

**Recommendation:** `meta` should be `meta?: (context: { viewName, partition, lastCommittedId }) => Record<string, unknown>` or accept a Promise for async metadata.

### 3.6 Missing Methods ❌

The `materialized-view-runtime.js` exposes 7 methods. The proposal's session interface only accounts for 2:

| Runtime Method | Proposal Covers? |
|---|---|
| `loadMaterializedView` | ✅ → `getView` |
| `subscribeMaterializedView` | ✅ → `subscribeView` |
| `onCommittedEvent` | ❌ (internal wiring, not exposed) |
| `evictMaterializedView` | ❌ Missing |
| `invalidateMaterializedView` | ❌ Missing |
| `flushMaterializedView` | ❌ Missing |
| `flushMaterializedViews` | ❌ Missing |
| `close` | ❌ (internal lifecycle) |

`evictMaterializedView` and `invalidateMaterializedView` are important for memory management in multi-partition views. Without them, the session cannot prune hot entries for removed partitions.

**Recommendation:** Add to the session interface:
```ts
evictView(name: string, partition: string): Promise<void>;
invalidateView(name: string, partition: string): Promise<void>;
flushViews(): Promise<void>;
```

---

## 4. partitionPattern Feature Evaluation

### 4.1 Current Multi-Partition Mechanism

The runtime supports multi-partition views through:

1. **`matchPartition`** — determines if an event matches a loaded partition (materialized-view.js line 120-124)
2. **Lazy partition hydration** — partitions are created on first `load` or `subscribe` (runtime lines 283-351)
3. **Per-partition hot entries** — each partition has independent state, checkpoint, and subscription (runtime lines 62-64)
4. **Event fan-out** — `onCommittedEvent` iterates all hot entries and checks `matchesPartition` for each (runtime lines 425-468)

### 4.2 Is `partitionPattern` a Good Abstraction? ⚠️ PARTIAL

**Good for:** Simple 1:1 partition extraction (e.g., `"scene-{sceneId}"` → partition `"scene-s1"` matches events with `partition: "scene-s1"`).

**Bad for:**
- **Cross-partition aggregation** — an "all-scenes-overview" view that needs events from all scene partitions
- **Hierarchical partitions** — events at `project:p1:story` matching views at `project:p1` level
- **Dynamic partition derivation** — partition determined by event payload, not event.partition string
- **Multi-key partition** — partition from compound event fields

**What it actually needs to be:** A function `(event) => string[] | null` that returns matching partition(s). The `partitionPattern` string template could be syntactic sugar that compiles to this function.

### 4.3 Missing: Auto-Adopt and Prune

The proposal mentions "automatic lifecycle" for `partitionPattern` but the actual `materialized-view-runtime.js` has **no auto-adopt or prune**. Partitions are only created explicitly via `loadMaterializedView` or `subscribeMaterializedView`.

The consumer's pain point (auto-adopting scene partitions from events) is a **new feature** that doesn't exist in the current runtime. The proposal hand-waves this as "automatic lifecycle" but provides no mechanism.

**What's actually needed:**
```ts
interface ViewDefinition {
  // ...
  partitionPattern?: {
    template: string;  // e.g., "scene-{sceneId}"
    extract: (event: CommittedEvent) => string[];  // derive partition(s) from event
    autoAdopt?: boolean;    // auto-create hot entry on first matching event
    autoPrune?: boolean;    // auto-evict + delete checkpoint when partition is "dead"
    pruneCondition?: (state: unknown) => boolean;  // when is a partition "dead"?
  };
}
```

### 4.4 Missing: Partition Discovery

Currently, the runtime only knows about partitions that have been explicitly loaded. For `partitionPattern` to work, the runtime would need to:
1. Scan events during hydration to discover new partitions
2. Auto-create hot entries for discovered partitions
3. Track "last event timestamp" per partition for pruning

This is a significant new feature, not just config sugar.

---

## 5. Checkpoint Integration Evaluation

### 5.1 Current Checkpoint Flow

The checkpoint flow in `materialized-view-runtime.js`:

1. **Hydration** (lines 283-351): On first access, `loadCheckpoint(viewName, partition)` is called. If checkpoint version ≠ definition version, checkpoint is deleted and replay starts from scratch.
2. **Replay**: Events after `lastCommittedId` are fetched in chunks and reduced.
3. **Save** (lines 217-228): After reduce, `scheduleFlush` decides when to persist based on checkpoint mode.
4. **Modes** (materialized-view.js lines 33-68): `"immediate"` | `"manual"` | `"debounce"` | `"interval"`, plus optional `maxDirtyEvents`.

### 5.2 Does Proposed `checkpoint.meta` Work? ⚠️ NEEDS WIRING

The proposal adds `checkpoint.meta?: () => Record<string, unknown>` to `ViewDefinition`. Currently:

- `saveCheckpoint` in runtime (line 219) sends `{ viewName, viewVersion, partition, value, lastCommittedId, updatedAt }` to the adapter
- The adapter (e.g., sqlite store, line 575-590) persists only these fields — **no `meta` column in the schema**

**What's needed:**
1. Add `meta` to the `saveCheckpoint` payload in runtime
2. Add `meta` column to all store schemas (SQLite, IndexedDB, in-memory)
3. Return `meta` from `loadCheckpoint`
4. Add `meta` to the `CheckpointData` type

This is feasible but touches **all 6 store implementations** and the adapter interface (Part 1).

### 5.3 Version Mismatch Handling

The current runtime handles version mismatches by deleting the checkpoint and replaying from scratch (lines 299-307):
```js
if (checkpoint && checkpoint.viewVersion !== definition.version) {
  if (typeof deleteCheckpoint === "function") {
    await deleteCheckpoint({ viewName: definition.name, partition });
  }
  checkpoint = undefined;
}
```

The proposal doesn't mention version mismatch handling. It should — this is a critical behavior that consumers rely on when deploying new reducer versions.

### 5.4 Missing: Close-time Flush

The current runtime's `close()` method (lines 557-573) **clears all timers and entries without flushing**. The stores (e.g., sqlite, lines 617-621) explicitly call `flushMaterializedViews()` before `close()`:

```js
if (materializedViewRuntime) {
  await materializedViewRuntime.flushMaterializedViews();
  await materializedViewRuntime.close();
}
```

The proposal doesn't mention flush-on-close behavior. If views are managed by the session, the session must flush before close.

---

## 6. Breaking Changes for Existing Consumers

### 6.1 Signature Changes ⚠️

The proposal changes the session creation signature from:
```js
// Current
createCommandSyncSession({
  token, actor, projectId, transport, store, logger, reconnect,
  schemaVersion, mapCommandToSyncEvent, mapCommittedToCommand,
  onCommittedCommand, onEvent, swallowTransportDisconnect,
})
```

To (proposed):
```js
createCommandSyncSession({
  token, actor: { clientId }, projectId, transport, store,
  mapCommandToSyncEvent, mapCommittedToCommand,
  views?: ViewDefinition[],
  onCommandCommitted?, onStatusChange?, onViewUpdate?, onError?,
  reconnect?, logger?,
})
```

**Breaking changes:**
1. `actor.userId` removed from proposal (only `clientId` shown) — but current code requires both (line 65)
2. `onCommittedCommand` → `onCommandCommitted` (renamed)
3. `schemaVersion` removed from proposal
4. `swallowTransportDisconnect` removed from proposal
5. `onEvent` removed from proposal (replaced by specific callbacks)
6. Callback payload changed: `sourceType` → `isLocal` (different semantics)

### 6.2 Return Type Changes

The current session returns `submitCommands` as an array of IDs (strings). The proposal changes `CommandResult` to a discriminated union:
```ts
| { id: string; status: "committed"; committedId: number }
| { id: string; status: "queued" }
| { id: string; status: "rejected"; reason: string; message: string }
```

This is **backward-incompatible** — consumers expecting `string[]` from `submitCommands` would break.

### 6.3 Removed Methods

The proposal removes:
- `submitEvents()` — currently exposed (line 238-244)
- `submitEvent()` — currently exposed (line 246-250)
- `syncNow()` — currently exposed (line 252-254)
- `flushDrafts()` — currently exposed (line 256-258)
- `setOnlineTransport()` — currently exposed (line 260-267)
- `getActor()` — currently exposed (line 269)

Some of these may be oversights in the proposal, but they would break consumers.

### 6.4 View Ownership Transfer ⚠️ SIGNIFICANT

Currently, views are owned by the **store**. The proposal moves them to the **session**. This means:

1. The store's `materializedViews` constructor parameter becomes redundant
2. All store methods (loadMaterializedView, subscribeMaterializedView, etc.) would need to be delegated back to the session
3. Or: the store no longer exposes view methods at all

**For the SQLite store** (788 lines), views are deeply integrated — the store creates the runtime, provides `loadCheckpoint`/`saveCheckpoint`/`deleteCheckpoint` implementations, and wires `onCommittedEvent` calls. Extracting this into the session would require the session to have access to the store's checkpoint infrastructure.

**Recommendation:** Views should remain in the store but be **configured via the session**. The session passes `views[]` through to the store's runtime. This avoids breaking the store-view integration while giving the session a facade for view access.

---

## 7. Missing Features in Proposal

### 7.1 `onCommittedEvent` Wiring

The current flow is:
1. `syncClient` receives committed events
2. Store's `applyCommittedBatch` / `applySubmitResult` calls `materializedViewRuntime.onCommittedEvent(event)` per event
3. Runtime updates hot entries, notifies subscribers

The proposal doesn't explain how the session would wire events to views. The session doesn't own the store's event pipeline. Two options:

**Option A:** Session wraps the store and intercepts events → complex, fragile
**Option B:** Session passes view definitions to the store at creation → store creates runtime → session delegates view methods → cleaner

### 7.2 Error Propagation from Views

The runtime has `pendingBackgroundError` and `assertHealthy()` (lines 69-89) for catching errors from debounced flush operations. The proposal's `onError` callback doesn't account for view-specific errors (reduce failures, checkpoint write failures).

### 7.3 Subscription Payload

The current `subscribeMaterializedView` `onChange` receives:
```js
{ viewName, partition, value, lastCommittedId, updatedAt }
```

The proposal's `subscribeView` `onChange` receives `ViewUpdate` (undefined type). Need to confirm this matches.

### 7.4 emitCurrent Flag

`subscribeMaterializedView` accepts `emitCurrent = true` (line 382) to optionally skip the initial emission. The proposal's `subscribeView` doesn't mention this.

### 7.5 `reduce` Return Convention

The actual reducer (materialized-view.js line 163):
```js
const next = definition.reduce({ state, event: toReducerEvent(event), partition });
return next === undefined ? state : next;
```

Returning `undefined` means "no change" — the state is preserved. This convention must be documented in the proposal.

---

## 8. Recommendations

### 8.1 Keep Views in the Store, Configure via Session

```ts
function createCommandSyncSession({
  // ... existing params ...
  views?: ViewDefinition[];  // passed to store
}): CommandSyncSession;
```

The session creates the store with `views[]`, then delegates `getView()`, `subscribeView()`, etc. to the store's existing methods. This avoids breaking the store-view integration.

### 8.2 Fix ViewDefinition to Match Reality

```ts
interface ViewDefinition {
  name: string;
  version?: string;  // defaults to "1"
  reduce: (ctx: { state: unknown, event: object, partition: string }) => unknown;
  initialState?: unknown | ((partition: string) => unknown);
  matchPartition?: (ctx: { loadedPartition: string, eventPartition: string, event: object }) => boolean;
  checkpoint?: {
    mode: "immediate" | "manual" | "debounce" | "interval";
    debounceMs?: number;
    intervalMs?: number;
    maxDirtyEvents?: number;
    meta?: (ctx: { viewName: string, partition: string, lastCommittedId: number }) => Record<string, unknown>;
  };
}
```

### 8.3 Add Missing Session Methods

```ts
interface CommandSyncSession {
  // ... proposed methods ...
  evictView(name: string, partition: string): Promise<void>;
  invalidateView(name: string, partition: string): Promise<void>;
  flushViews(): Promise<void>;
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;  // keep existing
  flushDrafts(): Promise<void>;  // keep existing
  setOnlineTransport(transport: object): Promise<void>;  // keep existing
}
```

### 8.4 Add partitionPattern as Sugar, Not Replacement

```ts
partitionPattern?: string | {
  template: string;
  extract: (event: CommittedEvent) => string[];
  autoAdopt?: boolean;
  pruneCondition?: (state: unknown) => boolean;
};
```

This compiles to a `matchPartition` function + optional lifecycle hooks.

### 8.5 Preserve Backward-Compatible `submitCommands` Return

Either keep returning `string[]` from `submitCommands`, or add a new method (`submitCommandsWithResult`) for the discriminated union return type.

---

## 9. Summary Table

| Proposal Claim | Status | Issue |
|---|---|---|
| No view management in session | ✅ Correct | Confirmed by source |
| 3,932 → 50 lines | ⚠️ Overstated | Realistic: ~3,582 → ~100-150 lines |
| `reduce: (state, event) => unknown` | ❌ Wrong | Actual: `({ state, event, partition }) => unknown` |
| Checkpoint modes: off/every/threshold | ❌ Wrong | Actual: immediate/manual/debounce/interval |
| `partitionPattern` replaces consumer code | ⚠️ Partial | Needs extract function + lifecycle hooks |
| `checkpoint.meta` is new | ✅ Correct | Genuinely new feature |
| Views declared at session creation | ⚠️ Partial | Must still pass through to store |
| Missing evict/invalidate/flush | ❌ Omitted | Critical for multi-partition memory management |
| No breaking changes noted | ❌ Wrong | 6+ breaking signature changes |
| `submitCommands` returns discriminated union | ⚠️ Breaking | Current returns `string[]` |
