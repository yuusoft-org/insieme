# Persisted Projection Checkpoints (Future Extension Draft)

This is a design draft for future consideration. It is not part of the current client-store implementation.

## Problem

Insieme already supports materialized views as partition-scoped derived state, and SQLite/LibSQL client stores already persist those views. That is useful, but it does not yet solve the full browser-side cold-start problem for large event histories.

Current gaps:

- `createIndexedDbClientStore(...)` does not support persistent materialized views.
- Large clients still need full replay before they can serve exact derived reads after a reload.
- Some clients need overview/listing reads across many entities without loading full detail state for each entity.
- Some clients need partition-aware hydration and eviction so memory use scales with the active screen, not the whole dataset.
- Apps should be able to build projections directly from Insieme's command profile (`event.type === "event"`, `payload.schema`, `payload.data`) instead of inventing a second local event wrapper just for replay.

## Goals

1. Exact reads: when a materialized view read resolves, it must reflect all committed events already stored locally for the target cursor snapshot.
2. Bounded cold start: startup cost should be checkpoint load plus tail replay, not full-history replay.
3. Controlled write cost: the library may avoid persisting every view update immediately, while still keeping same-session reads exact.
4. Partition-aware memory use: only hydrate the partitions the caller needs; allow eviction of cold partitions.
5. Summary/detail support: overview pages should be able to read small summary projections for many partitions without hydrating full detail projections.
6. Command-profile reuse: apps should be able to reuse `command-profile.js` event shape and schema reducers directly.
7. Browser parity: IndexedDB should support the same projection model already available in SQLite/LibSQL.

## Non-Goals

- Replacing the committed event log as the source of truth.
- Guaranteeing zero replay in all cases.
- Building a general-purpose ORM or query engine.
- Serving stale reads by default.

## Proposed Model

A materialized view remains the projection definition.

A checkpoint is the persisted snapshot of one materialized view partition at a specific committed offset.

The runtime should maintain two related forms of state:

- Live projection state in memory for exact reads in the current session.
- Persisted checkpoints on disk for fast cold hydration.

### Read Path

For `loadMaterializedView({ viewName, partition })`:

1. Capture the current local committed cursor snapshot.
2. Load the checkpoint for `(viewName, partition)` if it exists.
3. Replay committed events after that checkpoint offset up to the captured cursor.
4. Return the exact state for that cursor.
5. Keep the hydrated state hot in memory for subsequent reads.

This preserves exact reads without requiring immediate checkpoint persistence after every commit.

### Write Path

When committed events are applied locally:

1. Update any already-hydrated live projection states synchronously.
2. Mark the affected `(viewName, partition)` checkpoints as dirty.
3. Flush dirty checkpoints to persistent storage using a policy.

Checkpoint persistence can be:

- immediate,
- debounced,
- interval-based,
- or forced after `N` dirty events.

The important rule is that the persisted checkpoint may lag, but the live in-memory projection returned in the active session may not.

## Why This Model

Persisting every view update on every commit keeps cold reads fast, but it increases write cost and storage churn.

Debouncing persisted checkpoints reduces write amplification, but a persisted checkpoint alone cannot guarantee exact reads after restart.

The hybrid model solves both:

- same-session reads stay exact because live state is updated on commit,
- restart cost stays bounded because persisted checkpoints shrink replay to the tail.

## Projection Scope

The existing materialized-view scope is `(viewName, partition)`. That is the right primary unit to keep.

What needs to improve is how the runtime handles many partitions:

- hydrate partitions lazily,
- batch reads across partitions,
- evict cold partitions,
- track checkpoint offsets per `(viewName, partition)`.

A single global materialized view for an entire dataset defeats the purpose for large clients.

The intended pattern is:

- one small index projection for listing/order/discovery,
- summary projections for overview cards/rows,
- detail projections for editor/detail pages.

Overview pages should read summary projections across many partitions and avoid hydrating full detail projections for each entity.

## Required Library Changes

### 1. IndexedDB Support For Persistent Materialized Views

Extend `createIndexedDbClientStore(...)` to accept `materializedViews` and persist checkpoint state.

Required capabilities:

- materialized-view state storage,
- checkpoint offset storage,
- version-aware invalidation,
- rebuild/catch-up logic,
- parity with the SQLite/LibSQL feature set.

### 2. Per-Partition Checkpoint Offsets

Current persistent materialized-view support stores one offset per view.

That is not sufficient for lazy partition hydration with eviction. If partition `A` is hot and partition `B` is cold, the runtime needs to know whether `B` has been caught up independently.

The checkpoint identity should therefore include at least:

- `view_name`
- `view_version`
- `partition`
- `last_committed_id`
- serialized `value`
- `updated_at`

This is the key storage-model change needed for large partitioned clients.

### 3. Shared Projection Runtime

Materialized-view catch-up, checkpoint flushing, version invalidation, and batched hydration should not be reimplemented separately in each store adapter.

Insieme should factor the projection runtime into shared logic used by:

- in-memory client store,
- IndexedDB client store,
- SQLite client store,
- LibSQL client store.

Store adapters should mainly provide persistence primitives; projection semantics should stay aligned across backends.

### 4. Checkpoint Flush Policy

Materialized-view definitions need optional checkpoint policy settings.

Example shape:

```js
{
  name: "scene-summary",
  version: "1",
  checkpoint: {
    mode: "debounce",
    debounceMs: 1000,
    maxDirtyEvents: 100,
  },
  initialState: () => ({ ... }),
  reduce: createReducer({ ... }),
}
```

The exact option names can change, but the runtime needs to support:

- immediate flush,
- debounced flush,
- interval flush,
- max-dirty-event guardrails,
- explicit flush on shutdown when the host environment allows it.

Checkpoint writes must be monotonic: an older offset must never overwrite a newer checkpoint.

### 5. Batched Multi-Partition Reads

The current API supports one partition read at a time.

Large overview screens need a batched form, for example:

```js
await store.loadMaterializedViews({
  viewName: "scene-summary",
  partitions: ["scene:1", "scene:2", "scene:3"],
});
```

The library should hydrate and catch up those partitions efficiently in one pass where possible.

Without this, apps will implement their own batching and duplicate store logic.

### 6. Browser-Friendly Catch-Up

Cold rebuilds and large tail replays in the browser must not lock the main thread for seconds.

The IndexedDB/browser runtime needs:

- chunked replay,
- yielding between chunks,
- optional progress callbacks or instrumentation hooks.

This is required even after checkpoints exist, because version invalidation and large cold tails still need replay.

### 7. Memory And Eviction

The runtime should keep hot projection partitions in memory, but it should not require all partitions to stay resident.

Required behavior:

- lazy hydrate on first read,
- manual eviction API first,
- optional LRU/TTL policy later,
- rehydrate from checkpoint plus tail replay after eviction.

### 8. Reducer And Export Ergonomics

`createReducer(...)` already supports the command-profile event shape (`event.type === "event"`, `payload.schema`, `payload.data`). That should become the standard projection path.

Changes needed:

- export `createReducer` from `src/client.js` and `src/browser.js`,
- document command-profile reducers as the default projection pattern,
- avoid introducing a second default reducer/event convention for apps.

If the library later adds more generic reducer helpers, they should extend the model without weakening the command profile as the default.

### 9. Command-Profile Unification

Insieme already has `commandToSyncEvent(...)` and `committedSyncEventToCommand(...)` in `command-profile.js`.

The library should lean into that shape as the canonical event contract for projection-friendly apps:

- `event.type === "event"`
- `event.payload.schema`
- `event.payload.data`
- optional metadata like `commandId`, `commandVersion`, `actor`, `projectId`, `clientTs`

The goal is to let apps reuse one event shape across:

- submit,
- sync,
- replay,
- materialized views,
- summary/detail projections.

Apps should not need a second local wrapper event shape just to get fast projections.

### 10. Diagnostics

Projection performance needs first-class instrumentation.

At minimum, the runtime should expose timing hooks or debug logging for:

- checkpoint load,
- tail replay,
- cold rebuild from zero,
- checkpoint flush,
- batch hydration.

Without this, consumers cannot verify whether the projection layer is actually solving their startup bottleneck.

## API Direction

The existing API can stay as the base surface:

```js
await store.loadMaterializedView({ viewName, partition });
```

Recommended additions:

```js
await store.loadMaterializedViews({ viewName, partitions });
await store.evictMaterializedView({ viewName, partition });
await store.invalidateMaterializedView({ viewName, partition });
await store.flushMaterializedViews();
```

The names can change, but the runtime needs equivalent capabilities.

## Recommended Consumer Pattern

For a partitioned domain model, apps should define a small set of projections:

- index projection for ordering/discovery,
- summary projection per partition,
- detail projection per partition only when detail reads are truly needed.

This lets overview screens read summaries and editor screens read details without forcing the whole dataset into memory.

## Rollout Plan

### Phase 1

- Export `createReducer` from browser/client entrypoints.
- Add this design to the docs.
- Align docs around command-profile reducers as the recommended projection shape.

### Phase 2

- Extract a shared projection runtime.
- Add per-partition checkpoint model.
- Keep SQLite/LibSQL behavior compatible while moving to the shared runtime.

### Phase 3

- Add IndexedDB persistent materialized-view support.
- Add chunked browser catch-up.
- Add explicit instrumentation.

### Phase 4

- Add batched multi-partition reads.
- Add eviction APIs.
- Tune checkpoint policies and defaults.

## Acceptance Criteria

This work is successful when all of the following are true:

- IndexedDB clients can use persistent materialized views.
- A materialized view read is exact for the local cursor snapshot used by that read.
- Checkpoint persistence can be deferred without making same-session reads stale.
- The runtime can hydrate a subset of partitions without loading every partition.
- Overview/listing pages can read summary projections across many partitions efficiently.
- Apps can standardize on Insieme's command-profile event shape for submit, replay, and projections.
- Cold-start performance is dominated by checkpoint load plus tail replay rather than full-history replay.
