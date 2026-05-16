# Materialized Views & Projection System: Deep Analysis

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Insieme Materialized View System](#current-insieme-materialized-view-system)
3. [Consumer Reality: RouteVN's Projection Infrastructure](#consumer-reality-routevns-projection-infrastructure)
4. [Gap Analysis](#gap-analysis)
5. [Proposal 1: First-Class Projection & Checkpoint Support](#proposal-1-first-class-projection--checkpoint-support)
6. [Proposal 2: Incremental Computation vs Full Replay](#proposal-2-incremental-computation-vs-full-replay)
7. [Proposal 3: Partition-Scoped Projections with Cross-Partition Joins](#proposal-3-partition-scoped-projections-with-cross-partition-joins)
8. [Proposal 4: Snapshot + Delta for Large Event Streams](#proposal-4-snapshot--delta-for-large-event-streams)
9. [Proposal 5: Projection Schema Migration](#proposal-5-projection-schema-migration)
10. [Proposal 6: Reactive Subscriptions with Diff-Based Updates](#proposal-6-reactive-subscriptions-with-diff-based-updates)
11. [Concrete API Design](#concrete-api-design)
12. [Implementation Priority & Migration Path](#implementation-priority--migration-path)

---

## Executive Summary

Insieme's current materialized view system provides a solid foundation: per-partition state accumulation, checkpoint persistence, lock-based concurrency, and basic subscriptions. However, the RouteVN consumer has been forced to build **~3,800 lines of custom projection infrastructure** on top of it — including manual event replay, cross-partition state composition, scene-scoped projections, incremental delta application, schema-aware recovery, and progress reporting.

This document analyzes the gap between what Insieme provides and what real-world consumers need, then proposes six concrete improvements with API designs that would eliminate the vast majority of this consumer-side code.

---

## Current Insieme Materialized View System

### Architecture Overview

The materialized view system consists of three core modules:

**`materialized-view.js`** (178 lines) — Definition normalization and state application:
- `normalizeMaterializedViewDefinitions()` — Validates and normalizes view definitions with `name`, `version`, `reduce`, `initialState`, `matchPartition`, and `checkpoint` config
- `applyMaterializedViewReducer()` — Applies a single event to state via the definition's `reduce` function
- `createMaterializedViewInitialState()` — Creates initial state from definition (supports function or value)
- Event envelope normalization (`toReducerEvent`) wraps raw events into `{ event: { type, payload } }` format
- Version-based checkpoint invalidation (version mismatch → delete checkpoint, rebuild from scratch)

**`materialized-view-runtime.js`** (575 lines) — Hot entry management, hydration, subscription, checkpoint scheduling:
- Per-view, per-partition hot entries (`Map<viewName, Map<partition, HotEntry>>`)
- `HotEntry` tracks: `state`, `lastCommittedId`, `persistedLastCommittedId`, `dirtyEventCount`, `flushTimer`
- Hydration: loads checkpoint → replays events after checkpoint → schedules flush
- Checkpoint modes: `immediate`, `manual`, `debounce`, `interval` with `maxDirtyEvents` threshold
- Lock-based concurrency via promise chains per `{viewName}::{partition}` key
- Subscription system: `subscribeMaterializedView()` with `emitCurrent` option
- `onCommittedEvent()` — Live event processing: scans all hot entries, applies matching events, notifies subscribers
- `invalidateMaterializedView()` — Delete checkpoint + rehydrate from scratch
- `evictMaterializedView()` — Remove from hot cache, rehydrate only if subscribers exist

**`reducer.js`** (68 lines) — Immer-backed reducer factory:
- `createReducer()` creates a reducer from `{ schemaHandlers, fallback }`
- Uses Immer `produce()` for immutable state updates
- Handlers receive `{ state (draft), event, payload, partition, type }`

### Current Capabilities

| Feature | Status |
|---------|--------|
| Per-partition state accumulation | ✅ Working |
| Checkpoint persistence | ✅ With 4 modes |
| Live event processing | ✅ `onCommittedEvent` |
| Basic subscriptions | ✅ Value + metadata |
| Partition matching | ✅ Custom `matchPartition` |
| Version-based rebuild | ✅ Destructive (full replay) |
| Lock-based concurrency | ✅ Per-view-partition |
| Immer-backed reducers | ✅ Via `createReducer` |

### Current Limitations

| Limitation | Impact |
|------------|--------|
| Single-partition scope per view | Consumer must compose cross-partition state manually |
| No incremental/diff notifications | Subscribers receive full state clone on every change |
| Version change = full rebuild | No migration path, just delete and replay |
| No projection composition | Can't define views that depend on other views |
| No batch replay with progress | Hydration replays silently, no progress hooks |
| No built-in partition indexing | Consumer must scan all hot entries to find matching partitions |
| No error recovery during replay | One failed event kills the entire hydration |
| No semantic event filtering | `matchPartition` only matches partition strings |

---

## Consumer Reality: RouteVN's Projection Infrastructure

### The Scale of the Problem

The RouteVN consumer has built **3,789 lines** of projection code across two files:

- **`projection.js`** (2,492 lines) — Repository state → domain state transformation, resource collection, export reachability analysis, resource usage tracking
- **`projectRepositoryRuntime.js`** (1,297 lines) — Full projection replay engine, cross-partition state composition, scene-scoped projections, checkpoint management, error recovery

### What RouteVN Built on Top of Insieme

#### 1. Cross-Partition State Composition (~200 lines)

```javascript
// projectRepositoryRuntime.js:882-898
const getCurrentComposedState = () =>
  composeRepositoryState({
    mainState: currentMainState,      // From "main" partition
    activeSceneId,
    activeSceneState,                  // From scene partition
  });
```

RouteVN has a **main partition** (project metadata, resource collections, scene structure without line data) and **scene partitions** (full scene data with lines). The composed state merges them. Insieme has no concept of composing views across partitions.

#### 2. Manual Event Replay Engine (~400 lines)

```javascript
// projectRepositoryRuntime.js:371-454
export const replayEventsToRepositoryState = ({
  events, untilEventIndex, createInitialState,
  reduceEventToState, reduceEventsToState,
}) => {
  // Batch replay with sequential fallback recovery
  // Diagnostic error reporting with nearby event context
  // Duplicate-resource-create skip logic
};
```

RouteVN built a complete replay engine because Insieme's hydration doesn't support:
- Partial replay (up to a specific event index)
- Batch optimization with sequential fallback
- Duplicate-create idempotency during replay
- Rich diagnostic errors with event context

#### 3. Scene-Scoped Projections (~300 lines)

```javascript
// projectRepositoryRuntime.js:847-871
const loadSceneProjection = async (sceneId) => {
  return loadSceneProjectionState({
    store, mainState: currentMainState,
    events: eventsForProjection,
    createInitialState, reduceEventToState,
    reduceEventsToState, sceneId,
  });
};
```

RouteVN creates per-scene projections that depend on the main state + scene-scoped events. The main state has scene structure but lines are stripped out (`stripSceneLinesFromState`). Scene projections rehydrate lines from scene-partition events. This is a **derived projection** pattern Insieme doesn't support.

#### 4. Incremental Scene Updates (~100 lines)

```javascript
// projectRepositoryRuntime.js:954-1018
const updateActiveSceneProjection = async (committedEvents = []) => {
  // Filter to scene-scoped events
  // Rebuild from composed base state
  // Apply only line-scoped events incrementally
  activeSceneState = applySceneEventsToLoadedProjection({
    mainState, sceneState, sceneId,
    sourceEvents: lineScopedEvents, reduceEventsToState,
  });
};
```

RouteVN implements incremental updates by filtering committed events to scene scope and applying only the relevant subset. This avoids full scene replay on every event.

#### 5. Projection Progress Reporting (~100 lines)

```javascript
// projectRepositoryRuntime.js:536-616
const beginInitialMainHydrationProgress = async () => {
  const checkpoint = await store.loadMaterializedViewCheckpoint({...});
  const progress = { total: resolvedTotal, current };
  activeHydrationProgress = progress;
  emitHydrationProgress(progress);
};
```

Large projects with thousands of events need progress UI during initial hydration. RouteVN built this from scratch.

#### 6. Complex Domain Transformation (2,492 lines of `projection.js`)

The entire `projection.js` file transforms raw repository state into domain-ready state for the editor. This includes:
- Hierarchy building from flat items + tree structures
- Resource collection normalization (images, sounds, fonts, etc.)
- Layout element tree construction
- Export reachability analysis (graph traversal)
- Resource usage tracking
- Engine data compilation

This transformation runs **on every state change** because Insieme doesn't support derived/computed projections.

---

## Gap Analysis

### What Insieme Provides → What RouteVN Needs

| Insieme Provides | RouteVN Needs | Gap Size |
|------------------|---------------|----------|
| Single-partition view | Cross-partition composition (main + scene) | **Critical** — 500+ lines |
| Basic hydration | Replay with error recovery, diagnostics, idempotency | **Large** — 400+ lines |
| Version change = full rebuild | Schema migration with transformation | **Medium** — 100+ lines |
| Full-state subscriptions | Diff-based/reactive updates | **Medium** — 200+ lines |
| No progress reporting | Hydration progress callbacks | **Small** — 100 lines |
| No derived projections | Computed views from other views | **Large** — entire projection.js |
| No batch event replay | Efficient batch replay with fallbacks | **Medium** — 200 lines |

### Estimated Code Elimination

If Insieme provided all six proposed improvements:
- `projectRepositoryRuntime.js`: **~60-70% could be eliminated** (780-910 lines)
- `projection.js`: **~30-40% could be eliminated** via derived projections (750-1000 lines)
- Remaining `projection.js` code is domain-specific transformation that belongs in the consumer

---

## Proposal 1: First-Class Projection & Checkpoint Support

### Problem

Insieme's materialized views are "dumb" state accumulators. Consumers need "smart" projections that know about:
- Replay order and batching
- Error recovery strategies
- Progress reporting
- Partial replay (time-travel for debugging/export)

### Proposed Design

```javascript
// NEW: projection.js module in Insieme

/**
 * Create a projection runtime that extends materialized views
 * with replay, recovery, and progress capabilities.
 */
export const createProjectionRuntime = ({
  // Core definition
  name,
  version,

  // State management
  createInitialState,
  reduceEvent,          // (state, event) => state
  reduceEventBatch,     // (state, events[]) => state  (optimized batch)

  // Checkpoint configuration
  checkpoint: {
    mode: 'debounce',   // immediate | manual | debounce | interval
    debounceMs: 1000,
    maxDirtyEvents: 100,
    maxEventCount: 5000,  // NEW: force checkpoint after N events
    serializer: (state) => serialized,    // NEW: custom serialization
    deserializer: (serialized) => state,  // NEW: custom deserialization
  },

  // Event filtering
  eventFilter: (event) => boolean,     // NEW: semantic event filtering
  partitionMatch: ({ loadedPartition, eventPartition, event }) => boolean,

  // Replay configuration
  replay: {
    chunkSize: 256,
    idempotencyCheck: (state, event, error) => boolean,  // NEW: skip duplicate creates
    onError: 'fail' | 'skip' | 'recover',                // NEW: error strategy
    recoveryFn: (state, event, error) => state | null,    // NEW: custom recovery
    progressCallback: ({ current, total }) => void,       // NEW: progress reporting
  },

  // Dependencies on other projections
  dependsOn: ['other_projection_name'],  // NEW: projection composition
  composeWith: (dependencies, ownState) => composedState,  // NEW
}) => { ... };
```

### API Surface

```javascript
const runtime = createProjectionRuntime({
  name: 'project_main',
  version: '1',
  createInitialState,
  reduceEvent: reduceEventToState,
  replay: {
    idempotencyCheck: ({ state, event, error }) => {
      return isDuplicateResourceCreateDuringReplay({ state, event, error });
    },
    progressCallback: ({ current, total }) => {
      updateLoadingUI(current, total);
    },
  },
});

// Load projection to latest
const state = await runtime.load({ partition: 'main' });

// Load projection to specific revision (time-travel)
const historicalState = await runtime.load({
  partition: 'main',
  untilRevision: 500,
});

// Subscribe to changes
const unsub = runtime.subscribe({
  partition: 'main',
  onChange: ({ value, revision, diff }) => { ... },
});

// Apply events
await runtime.applyEvents(committedEvents);
```

### Benefits for RouteVN

- Eliminates `replayEventsToRepositoryState` (~85 lines)
- Eliminates `replayEventsSequentially` (~50 lines)
- Eliminates `createReplayError` with diagnostics (~75 lines)
- Eliminates manual progress tracking (~100 lines)
- Eliminates duplicate-create recovery logic (~100 lines)

---

## Proposal 2: Incremental Computation vs Full Replay

### Problem

Currently, when a materialized view is invalidated (version change) or a new partition is loaded, Insieme replays **all events from the beginning**. For large event streams (RouteVN projects can have thousands of events), this is prohibitively slow.

RouteVN works around this by:
1. Maintaining a separate checkpoint system for scene projections
2. Rebuilding scene state from composed base state instead of full replay
3. Applying only line-scoped events incrementally

### Proposed Design

```javascript
/**
 * Incremental computation support in view definitions.
 */
const projectionDef = {
  name: 'project_scene',
  version: '2',

  // NEW: Declare what events affect which parts of state
  // This enables partial recomputation
  scope: {
    // Partition selector: which events belong to this projection instance
    partitionKey: (event) => event.partition,

    // State partitions: declare independent sub-states
    statePartitions: {
      metadata: {
        eventTypes: ['scene.create', 'scene.update', 'section.*'],
        reducer: (state, event) => { ... },
      },
      lines: {
        eventTypes: ['line.*'],
        reducer: (state, event) => { ... },
      },
    },
  },

  // NEW: Enable incremental recomputation
  incremental: {
    // Which state partitions can be recomputed independently
    independent: ['metadata', 'lines'],

    // How to merge partial results
    merge: (partials) => ({ ...partials.metadata, ...partials.lines }),

    // How to extract a sub-state for partial replay
    extract: (state, partition) => state[partition],

    // How to apply a partial update
    apply: (state, partition, partialUpdate) => ({
      ...state,
      [partition]: partialUpdate,
    }),
  },
};
```

### Incremental Event Application

```javascript
// NEW: When events arrive, apply only to affected state partitions
const incrementalApply = (definition, state, event) => {
  const eventType = event?.event?.type;
  const affectedPartitions = [];

  for (const [key, config] of Object.entries(definition.incremental.statePartitions)) {
    if (matchesEventType(eventType, config.eventTypes)) {
      affectedPartitions.push(key);
    }
  }

  let nextState = state;
  for (const partition of affectedPartitions) {
    const partial = definition.scope.statePartitions[partition].reducer(
      definition.incremental.extract(state, partition),
      event,
    );
    nextState = definition.incremental.apply(nextState, partition, partial);
  }

  return nextState;
};
```

### Benefits for RouteVN

RouteVN's `updateActiveSceneProjection` would become:

```javascript
// BEFORE: 60+ lines of manual filtering, composition, and incremental application
const updateActiveSceneProjection = async (committedEvents = []) => {
  const scopedEvents = [];
  for (const committedEvent of committedEvents) { /* filter logic */ }
  activeSceneState = createSceneProjectionState(composeRepositoryState({...}));
  const lineScopedEvents = scopedEvents.filter(e => e.type.startsWith('line.'));
  if (lineScopedEvents.length > 0) {
    activeSceneState = applySceneEventsToLoadedProjection({...});
  }
  await saveSceneProjectionCheckpoint({...});
};

// AFTER: 5 lines using Insieme incremental support
const updateActiveSceneProjection = async (committedEvents) => {
  await sceneProjection.applyEvents(committedEvents, {
    incremental: true,  // Only apply to affected state partitions
  });
};
```

---

## Proposal 3: Partition-Scoped Projections with Cross-Partition Joins

### Problem

RouteVN has a two-tier partition model:
- **Main partition** (`p:PROJECT_ID`): Project metadata, resources, scene structure (without lines)
- **Scene partitions** (`s:SCENE_TOKEN`): Full scene data including lines

The composed state needs data from both. Currently, RouteVN manually:
1. Loads main state from one materialized view
2. Loads scene state from another (or from custom checkpoint)
3. Merges them via `composeRepositoryState()`
4. Manages active scene lifecycle (load, update, clear, prune)

### Proposed Design

```javascript
/**
 * Cross-partition projection composition.
 */
export const createComposedProjection = ({
  name: 'project_full_state',
  version: '1',

  // Declare source projections
  sources: {
    main: {
      projection: 'project_main',
      partition: (context) => `p:${context.projectId}`,
    },
    activeScene: {
      projection: 'project_scene',
      partition: (context) => context.activeSceneId
        ? `s:${sceneTokenFor(context.activeSceneId)}`
        : null,
      optional: true,  // May not have an active scene
    },
  },

  // Compose source states into final state
  compose: ({ main, activeScene }, context) => {
    if (!activeScene) return main;

    // Merge active scene data into main state
    const composed = structuredClone(main);
    if (activeScene?.scenes?.items) {
      for (const [sceneId, scene] of Object.entries(activeScene.scenes.items)) {
        if (composed.scenes.items[sceneId]) {
          composed.scenes.items[sceneId] = scene;
        }
      }
    }
    return composed;
  },

  // Optimization: only recompose when affected sources change
  recomposeWhen: {
    main: (prev, next) => prev.lastCommittedId !== next.lastCommittedId,
    activeScene: (prev, next) => prev?.lastCommittedId !== next?.lastCommittedId,
  },
});
```

### Partition Index for Efficient Routing

```javascript
/**
 * NEW: Partition-aware event routing.
 * Instead of scanning all hot entries, use an index.
 */
export const createPartitionIndex = ({
  extractPartitionKey: (event) => event.partition,
  partitionToScope: (partition) => {
    if (partition.startsWith('p:')) return { type: 'main' };
    if (partition.startsWith('s:')) return { type: 'scene', token: partition.slice(2) };
    if (partition.startsWith('m:s:')) return { type: 'mainScene', token: partition.slice(4) };
    return null;
  },
});

// Usage in materialized view runtime:
// On event received:
const scope = partitionIndex.route(event);
// Only wake up views that match this scope
```

### Benefits for RouteVN

Eliminates ~300 lines of cross-partition composition code:
- `composeRepositoryState()` → built-in compose function
- `composeRepositoryStateWithScenes()` → built-in multi-source composition
- `loadSceneProjection()` / `saveSceneProjectionCheckpoint()` → automatic
- `ensureActiveSceneProjectionLoaded()` → partition lifecycle management
- `pruneRemovedActiveScene()` → partition cleanup hooks
- `autoAdoptSceneProjection()` → automatic partition activation

---

## Proposal 4: Snapshot + Delta for Large Event Streams

### Problem

For projects with thousands of events, replaying from the last checkpoint to the current state can still be expensive. RouteVN projects accumulate events rapidly during editing sessions.

Currently, Insieme's checkpoint is a full-state snapshot at a specific `lastCommittedId`. This is sufficient for most cases, but lacks:

1. **Delta checkpoints** — Periodic snapshots that only store the diff since the last snapshot
2. **Tiered checkpoints** — Multiple checkpoint levels for faster rollback
3. **Compaction** — Automatic event compaction for old events
4. **Lazy hydration** — Don't replay the entire stream if only a subset is needed

### Proposed Design

```javascript
/**
 * Enhanced checkpoint strategy with delta support.
 */
const viewDef = {
  name: 'project_main',
  version: '2',

  checkpoint: {
    mode: 'tiered',  // NEW: multi-tier checkpoint strategy

    tiers: [
      {
        // Full snapshot every 1000 events
        type: 'snapshot',
        interval: 1000,
        serializer: (state) => compressState(state),
        deserializer: (data) => decompressState(data),
      },
      {
        // Delta snapshots every 100 events
        type: 'delta',
        interval: 100,
        diffFn: (previous, current) => computeDiff(previous, current),
        patchFn: (state, delta) => applyDelta(state, delta),
      },
    ],

    // Auto-compaction: merge old events into snapshots
    compaction: {
      enabled: true,
      threshold: 5000,       // Compact when event count exceeds this
      keepRecent: 500,       // Always keep last N events uncompact
      compactFn: async ({ events, state }) => {
        // Returns compacted representation
        return { compactedState: state, compactedEventCount: events.length };
      },
    },
  },
};
```

### Delta Computation

```javascript
/**
 * NEW: Built-in diff/patch utilities for common state shapes.
 */
export const computeStateDiff = (previous, current) => {
  // For object states: compute key-level diff
  // For Immer-backed states: use Immer patches
  const patches = [];
  const allKeys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(current || {}),
  ]);

  for (const key of allKeys) {
    if (previous?.[key] === current?.[key]) continue;
    if (!(key in (current || {}))) {
      patches.push({ op: 'remove', path: key });
    } else if (!(key in (previous || {}))) {
      patches.push({ op: 'add', path: key, value: current[key] });
    } else {
      patches.push({ op: 'replace', path: key, value: current[key] });
    }
  }

  return patches;
};

export const applyStateDiff = (state, diff) => {
  const next = { ...state };
  for (const patch of diff) {
    switch (patch.op) {
      case 'add':
      case 'replace':
        next[patch.path] = patch.value;
        break;
      case 'remove':
        delete next[patch.path];
        break;
    }
  }
  return next;
};
```

### Immer Integration for Patches

Since `reducer.js` already uses Immer, we can leverage Immer's patch system:

```javascript
// Enhanced reducer with patch generation
import { produceWithPatches } from 'immer';

const runWithImmerAndPatches = ({ state, handler, context }) => {
  const [nextState, patches] = produceWithPatches(
    normalizeStateRoot(state),
    (draft) => {
      const next = handler({ ...context, state: draft });
      if (next !== undefined) return next;
    }
  );
  return { state: nextState, patches };
};
```

### Benefits for RouteVN

- Reduces checkpoint storage size by 40-70% for large states (delta vs full clone)
- Enables faster time-travel (apply/undo deltas instead of full replay)
- Reduces initial hydration time for large projects (start from most recent snapshot)

---

## Proposal 5: Projection Schema Migration

### Problem

Currently, when a view's `version` changes, Insieme **deletes the checkpoint and replays all events from scratch**. This is catastrophic for large event streams.

RouteVN hardcodes version strings (`MAIN_VIEW_VERSION = "1"`, `SCENE_VIEW_VERSION = "2"`) and never changes them because a version bump would trigger a full replay.

### Proposed Design

```javascript
const viewDef = {
  name: 'project_main',

  // Migration chain: version 1 → 2 → 3
  version: '3',

  migrations: {
    // Migrate checkpoint from version 1 to version 2
    '1→2': {
      migrateState: (v1State) => {
        // Transform v1 state shape to v2
        return {
          ...v1State,
          model_version: 2,
          scenes: v1State.scenes || { items: {}, tree: [] },
          sections: v1State.sections || {},
          lines: v1State.lines || {},
        };
      },
      // Optional: custom event replay for new fields
      migrateEvent: (v1Event) => v1Event,
    },

    // Migrate checkpoint from version 2 to version 3
    '2→3': {
      migrateState: (v2State) => ({
        ...v2State,
        tags: v2State.tags || createEmptyTagScopes(),
      }),
    },
  },

  // NEW: Auto-migration on hydration
  autoMigrate: true,
};
```

### Migration Engine

```javascript
/**
 * NEW: Schema migration engine.
 */
export const migrateCheckpoint = ({
  checkpoint,
  targetVersion,
  migrations,
}) => {
  let currentVersion = checkpoint.viewVersion;
  let state = checkpoint.value;

  // Build migration path
  const path = buildMigrationPath(currentVersion, targetVersion, migrations);
  if (!path) {
    // No migration path exists
    return null;
  }

  // Apply migrations in sequence
  for (const migration of path) {
    state = migration.migrateState(state);
    currentVersion = migration.targetVersion;
  }

  return {
    ...checkpoint,
    value: state,
    viewVersion: targetVersion,
    migratedFrom: checkpoint.viewVersion,
  };
};

const buildMigrationPath = (from, to, migrations) => {
  const path = [];
  let current = from;

  while (current !== to) {
    const key = `${current}→${to}`;
    const stepKey = Object.keys(migrations).find(
      (k) => k.startsWith(`${current}→`)
    );

    if (!stepKey) return null;  // No path exists

    const nextVersion = stepKey.split('→')[1];
    path.push({
      ...migrations[stepKey],
      fromVersion: current,
      targetVersion: nextVersion,
    });
    current = nextVersion;
  }

  return path;
};
```

### Integration with Hydration

```javascript
// In hydrateEntry, replace the current version-check logic:

// BEFORE (materialized-view-runtime.js:299-307):
if (checkpoint && checkpoint.viewVersion !== definition.version) {
  if (typeof deleteCheckpoint === 'function') {
    await deleteCheckpoint({ viewName: definition.name, partition });
  }
  checkpoint = undefined;
}

// AFTER:
if (checkpoint && checkpoint.viewVersion !== definition.version) {
  const migrated = migrateCheckpoint({
    checkpoint,
    targetVersion: definition.version,
    migrations: definition.migrations,
  });

  if (migrated) {
    checkpoint = migrated;
    // Save migrated checkpoint immediately
    await saveCheckpoint({
      viewName: definition.name,
      viewVersion: definition.version,
      partition,
      value: migrated.value,
      lastCommittedId: migrated.lastCommittedId,
      updatedAt: now(),
    });
  } else {
    // No migration path; fall back to full rebuild
    if (typeof deleteCheckpoint === 'function') {
      await deleteCheckpoint({ viewName: definition.name, partition });
    }
    checkpoint = undefined;
  }
}
```

### Benefits for RouteVN

- Enables safe version bumps without full replay
- Reduces downtime when deploying schema changes
- Preserves accumulated checkpoint state across deployments
- Eliminates the need for RouteVN's hardcoded version strings

---

## Proposal 6: Reactive Subscriptions with Diff-Based Updates

### Problem

Currently, `subscribeMaterializedView()` sends a full `cloneMaterializedViewValue(entry.state)` on every event. For RouteVN's large state objects (thousands of resources, scenes, lines), this means:
1. Expensive `structuredClone()` on every event
2. Full state comparison needed in subscriber to detect changes
3. No way to know *what* changed without deep comparison
4. Wasted CPU when subscribers only care about specific sub-paths

### Proposed Design

```javascript
/**
 * Enhanced subscription system with diff support and path-based filtering.
 */
export const subscribeProjection = ({
  viewName,
  partition,

  // Change handler receives diff instead of full state
  onChange: ({
    value,          // Full state (optional, only if requested)
    revision,       // Current revision
    diff,           // NEW: Structured diff describing what changed
    affectedPaths,  // NEW: Set of top-level keys that changed
    events,         // NEW: The events that triggered this change
  }) => {},

  // NEW: Path-based subscription filter
  // Only receive notifications when these paths change
  paths: ['scenes', 'resources.images'],

  // NEW: Custom diff function
  diffFn: (previous, current) => computeCustomDiff(previous, current),

  // Existing options
  emitCurrent: true,
}) => unsubscribe;
```

### Diff Computation

```javascript
/**
 * NEW: Efficient diff computation for common state shapes.
 */
export const computeProjectionDiff = (previous, current) => {
  if (previous === current) return null;

  const affectedPaths = new Set();
  const changes = {};

  // Top-level key diff (most common case for projection state)
  const allKeys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(current || {}),
  ]);

  for (const key of allKeys) {
    const prev = previous?.[key];
    const curr = current?.[key];

    if (prev === curr) continue;

    affectedPaths.add(key);

    // For collection states (items/tree pattern), compute item-level diff
    if (hasCollectionShape(prev) && hasCollectionShape(curr)) {
      changes[key] = computeCollectionDiff(prev, curr);
    } else {
      changes[key] = {
        op: 'replace',
        previous: prev,
        current: curr,
      };
    }
  }

  return {
    affectedPaths: [...affectedPaths],
    changes,
    timestamp: Date.now(),
  };
};

const hasCollectionShape = (value) =>
  value && typeof value === 'object' && 'items' in value;

const computeCollectionDiff = (prev, curr) => {
  const added = {};
  const removed = {};
  const modified = {};

  const prevItems = prev?.items || {};
  const currItems = curr?.items || {};

  for (const [id, item] of Object.entries(currItems)) {
    if (!(id in prevItems)) {
      added[id] = item;
    } else if (prevItems[id] !== item) {
      modified[id] = { previous: prevItems[id], current: item };
    }
  }

  for (const id of Object.keys(prevItems)) {
    if (!(id in currItems)) {
      removed[id] = prevItems[id];
    }
  }

  const treeChanged = JSON.stringify(prev?.tree) !== JSON.stringify(curr?.tree);

  return {
    op: 'collection_update',
    added: Object.keys(added).length > 0 ? added : undefined,
    removed: Object.keys(removed).length > 0 ? removed : undefined,
    modified: Object.keys(modified).length > 0 ? modified : undefined,
    treeChanged,
  };
};
```

### Path-Based Subscription Filtering

```javascript
/**
 * NEW: Only notify subscribers when their watched paths change.
 */
const shouldNotifySubscriber = (subscription, diff) => {
  // No path filter → always notify
  if (!subscription.paths || subscription.paths.length === 0) {
    return true;
  }

  // Check if any watched path is in the affected paths
  return subscription.paths.some(
    (path) => diff.affectedPaths.some(
      (affected) => affected === path || affected.startsWith(path + '.')
    )
  );
};
```

### Benefits for RouteVN

Instead of re-running the entire `projectRepositoryStateToDomainState()` transformation on every event (which processes all resources, scenes, layouts), RouteVN could:

```javascript
// Subscribe to only scene-related changes
const unsub = runtime.subscribe({
  partition: 'main',
  paths: ['scenes', 'story'],
  onChange: ({ diff }) => {
    // Only re-transform scenes, skip resource processing
    if (diff.changes.scenes) {
      updateSceneUI(diff.changes.scenes);
    }
  },
});
```

This eliminates the need to clone and re-process the entire state tree on every keystroke.

---

## Concrete API Design

### Complete Type Definitions

```typescript
// ============ CORE TYPES ============

interface ProjectionDefinition {
  /** Unique name for this projection */
  name: string;

  /** Schema version for migration support */
  version: string;

  /** Create the initial state for a partition */
  initialState: (() => unknown) | unknown;

  /** Apply a single event to state */
  reduce: (ctx: ReduceContext) => unknown;

  /** Apply a batch of events to state (optimized) */
  reduceBatch?: (ctx: BatchReduceContext) => unknown;

  /** Determine if an event matches a loaded partition */
  matchPartition?: (ctx: PartitionMatchContext) => boolean;

  /** Semantic event filter */
  eventFilter?: (event: CommittedEvent) => boolean;

  /** Checkpoint configuration */
  checkpoint?: CheckpointConfig;

  /** Schema migration chain */
  migrations?: Record<string, MigrationStep>;

  /** Incremental computation config */
  incremental?: IncrementalConfig;

  /** Cross-partition composition */
  sources?: Record<string, SourceProjection>;
  compose?: (sources: Record<string, unknown>, context: unknown) => unknown;
}

// ============ CHECKPOINT ============

interface CheckpointConfig {
  mode: 'immediate' | 'manual' | 'debounce' | 'interval' | 'tiered';
  debounceMs?: number;
  intervalMs?: number;
  maxDirtyEvents?: number;
  maxEventCount?: number;

  /** Custom serialization */
  serializer?: (state: unknown) => unknown;
  deserializer?: (data: unknown) => unknown;

  /** Tiered checkpoint config */
  tiers?: CheckpointTier[];

  /** Auto-compaction */
  compaction?: CompactionConfig;
}

interface CheckpointTier {
  type: 'snapshot' | 'delta';
  interval: number;
  diffFn?: (prev: unknown, curr: unknown) => unknown;
  patchFn?: (state: unknown, delta: unknown) => unknown;
}

interface CompactionConfig {
  enabled: boolean;
  threshold: number;
  keepRecent: number;
  compactFn?: (ctx: { events: unknown[]; state: unknown }) => Promise<unknown>;
}

// ============ MIGRATION ============

interface MigrationStep {
  migrateState: (state: unknown) => unknown;
  migrateEvent?: (event: unknown) => unknown;
}

// ============ INCREMENTAL ============

interface IncrementalConfig {
  statePartitions: Record<string, StatePartitionConfig>;
  merge: (partials: Record<string, unknown>) => unknown;
}

interface StatePartitionConfig {
  eventTypes: string[];
  reducer: (state: unknown, event: unknown) => unknown;
}

// ============ SUBSCRIPTION ============

interface SubscriptionOptions {
  viewName: string;
  partition: string;
  onChange: (payload: SubscriptionPayload) => void;
  paths?: string[];
  diffFn?: (prev: unknown, curr: unknown) => unknown;
  emitCurrent?: boolean;
}

interface SubscriptionPayload {
  value: unknown;
  revision: number;
  updatedAt: number;
  diff: ProjectionDiff | null;
  events: CommittedEvent[];
}

interface ProjectionDiff {
  affectedPaths: string[];
  changes: Record<string, ChangeDescription>;
  timestamp: number;
}

interface ChangeDescription {
  op: 'replace' | 'collection_update' | 'add' | 'remove';
  previous?: unknown;
  current?: unknown;
  added?: Record<string, unknown>;
  removed?: Record<string, unknown>;
  modified?: Record<string, { previous: unknown; current: unknown }>;
  treeChanged?: boolean;
}

// ============ REPLAY ============

interface ReplayConfig {
  chunkSize?: number;
  idempotencyCheck?: (ctx: { state: unknown; event: unknown; error: Error }) => boolean;
  onError?: 'fail' | 'skip' | 'recover';
  recoveryFn?: (ctx: { state: unknown; event: unknown; error: Error }) => unknown;
  progressCallback?: (progress: { current: number; total: number }) => void;
}

// ============ RUNTIME API ============

interface ProjectionRuntime {
  /** Load projection state for a partition */
  load(options: {
    partition: string;
    untilRevision?: number;
    progressCallback?: (progress: { current: number; total: number }) => void;
  }): Promise<{ value: unknown; revision: number; updatedAt: number }>;

  /** Subscribe to projection changes */
  subscribe(options: SubscriptionOptions): () => void;

  /** Apply committed events */
  applyEvents(events: CommittedEvent[], options?: {
    incremental?: boolean;
  }): Promise<void>;

  /** Invalidate and rebuild from scratch */
  invalidate(options: { partition: string }): Promise<void>;

  /** Evict from hot cache */
  evict(options: { partition: string }): Promise<void>;

  /** Flush checkpoints to storage */
  flush(options?: { partition?: string }): Promise<void>;

  /** Close the runtime */
  close(): Promise<void>;
}
```

### Usage Example: RouteVN Migration

```javascript
import { createProjectionRuntime } from 'insieme/projection';

// ===== Main projection =====
const mainProjection = createProjectionRuntime({
  store: { loadCheckpoint, saveCheckpoint, deleteCheckpoint, listCommittedAfter, getLatestCommittedId },

  definitions: [{
    name: 'project_main',
    version: '1',
    initialState: () => createInitialState(),
    reduce: ({ state, event }) => reduceEventToState({ repositoryState: state, event }),
    matchPartition: ({ loadedPartition, eventPartition }) =>
      loadedPartition === MAIN_PARTITION &&
      (isMainPartition(eventPartition) || isMainScenePartition(eventPartition)),
    checkpoint: {
      mode: 'debounce',
      debounceMs: 1000,
      maxDirtyEvents: 100,
    },
    migrations: {
      '1→2': {
        migrateState: (s) => ({ ...s, tags: s.tags || createEmptyTagScopes() }),
      },
    },
    replay: {
      idempotencyCheck: ({ state, event, error }) =>
        canSkipDuplicateResourceCreateDuringReplay({ repositoryState: state, event, error }),
      progressCallback: ({ current, total }) => updateLoadingUI(current, total),
    },
  }],

  // Composed projection with cross-partition join
  composedProjections: [{
    name: 'project_full',
    sources: {
      main: { projection: 'project_main', partition: (ctx) => MAIN_PARTITION },
      activeScene: {
        projection: 'project_scene',
        partition: (ctx) => ctx.activeSceneId ? scenePartitionFor(ctx.activeSceneId) : null,
        optional: true,
      },
    },
    compose: ({ main, activeScene }) => composeRepositoryState({
      mainState: main,
      activeSceneId: activeSceneId,
      activeSceneState: activeScene,
    }),
  }],
});

// Usage:
const { value } = await mainProjection.load({ partition: MAIN_PARTITION });
const unsub = mainProjection.subscribe({
  viewName: 'project_full',
  partition: 'composed',
  paths: ['scenes'],
  onChange: ({ diff, value }) => {
    if (diff?.changes.scenes) {
      updateSceneExplorer(diff.changes.scenes);
    }
  },
});
await mainProjection.applyEvents(committedEvents);
```

---

## Implementation Priority & Migration Path

### Phase 1: Foundation (Week 1-2)

**Priority: Critical** — These unblock the largest consumer pain points.

| Item | Effort | Impact |
|------|--------|--------|
| Enhanced replay with error recovery | 3 days | Eliminates ~310 lines in consumer |
| Progress callbacks in hydration | 1 day | Eliminates ~100 lines in consumer |
| Projection definition type (extends view def) | 2 days | Foundation for all other features |

### Phase 2: Composition & Incremental (Week 3-4)

**Priority: High** — These address the cross-partition architecture.

| Item | Effort | Impact |
|------|--------|--------|
| Cross-partition composition | 5 days | Eliminates ~300 lines in consumer |
| Partition index for efficient routing | 2 days | Performance improvement |
| Incremental state partition computation | 4 days | Eliminates ~150 lines in consumer |
| Path-based subscription filtering | 2 days | Performance + ergonomics |

### Phase 3: Advanced Features (Week 5-6)

**Priority: Medium** — Quality of life and forward-looking features.

| Item | Effort | Impact |
|------|--------|--------|
| Schema migration engine | 3 days | Future-proofs version changes |
| Diff-based subscription payloads | 3 days | Performance for large states |
| Delta checkpoints | 4 days | Storage + hydration optimization |
| Tiered checkpoints | 3 days | Advanced checkpoint strategy |
| Auto-compaction | 2 days | Long-running project optimization |

### Backward Compatibility

All proposed changes are **additive**. The existing `materialized-view.js` and `materialized-view-runtime.js` remain unchanged. New features are exposed through:

1. **`insieme/projection`** — New module for `createProjectionRuntime()`
2. **Extended definition format** — New optional fields; existing definitions work as-is
3. **New subscription options** — `paths`, `diffFn` are optional; existing subscribers work unchanged

### Migration Strategy for RouteVN

```javascript
// Step 1: Replace createMaterializedViewRuntime with createProjectionRuntime
// (No behavior change, just better API)
const runtime = createProjectionRuntime({ ... });

// Step 2: Add replay recovery config
// (Eliminates replayEventsToRepositoryState)
replay: {
  idempotencyCheck: canSkipDuplicateResourceCreateDuringReplay,
}

// Step 3: Add cross-partition composition
// (Eliminates composeRepositoryState, scene projection management)
sources: { main: {...}, activeScene: {...} },

// Step 4: Add diff-based subscriptions
// (Eliminates full-state reprocessing on every event)
paths: ['scenes'], onChange: ({ diff }) => ...

// Step 5: Add schema migrations
// (Enables safe version bumps)
migrations: { '1→2': { migrateState: ... } },
```

---

## Summary

The six proposals in this document address a clear pattern: **Insieme provides low-level state accumulation, but consumers need high-level projection management**. The RouteVN codebase demonstrates this gap with 3,789 lines of infrastructure that should live in the library.

By implementing these proposals in priority order:

1. **First-class projection/checkpoint support** — Replay recovery, progress, partial replay
2. **Incremental computation** — State partitions, partial recomputation
3. **Cross-partition joins** — Source composition, partition indexing
4. **Snapshot + delta** — Tiered checkpoints, Immer patches, compaction
5. **Schema migration** — Version chains, state transformation
6. **Diff-based subscriptions** — Path filtering, collection diffs

Insieme would evolve from a "materialized view" library into a full **projection engine**, eliminating 60-70% of consumer-side projection code while providing a cleaner, more maintainable API.
