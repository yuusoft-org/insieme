
# Insieme

**Insieme** (Italian for *“together”*) is a foundational library for building **collaborative, consistent state**.
It provides a deterministic, event-based core for syncing application state across clients and a central authoritative server

---

## ✨ Features

- 🔁 **Offline-first** - Works offline and syncs when network is available
- 🧱 **Validation** - central server commits and validates changes.
- 💾 **Swappable storage adapters** — works in browser, desktop, or custom stores.
- ⚡ **Persistent snapshots** - Fast initialization by loading from snapshots instead of replaying all events.

---

## Canonical Architecture

For long-term robustness, Insieme standardizes on:

- One low-level implementation: model/event-sourcing core.
- One app-facing interface: strict command events via `type: "event"` + schema validation.
- Tree actions remain available as a compatibility layer for existing apps.

For new critical systems, prefer `mode: "model"` and expose domain commands from your service layer instead of raw tree mutations from UI handlers.

---

## 🚀 Quick Start

```js
import { createRepository } from "insieme";

const store = {
  async getEvents(payload) {  
    console.log(payload);  // should be {} or { partitions: [...] }
    return []; 
  },
  async appendEvent(event) { 
    console.log("saved", event);  // should be { type: ..., payload: {...} } or { type: ..., partitions: [...], payload: {...} }
  },
};

const model = {
  initialState: {
    explorer: { items: {}, tree: [] },
  },
  schemas: {
    "explorer.folderCreated": {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
  },
  reduce(draft, event) {
    if (event.payload.schema === "explorer.folderCreated") {
      const { id, name } = event.payload.data;
      draft.explorer.items[id] = { name, type: "folder" };
      draft.explorer.tree.push({ id, children: [] });
    }
  },
  version: 1,
};

const repository = createRepository({
  originStore: store,
  mode: "model",
  model,
});

await repository.init({
  initialState: model.initialState,
});

// apply an event
await repository.addEvent({
  type: "event",
  payload: {
    schema: "explorer.folderCreated",
    data: { id: "1", name: "New Folder" },
  },
});

// read the current state
console.log(repository.getState());

const repositoryWithPartition = createRepository({
  originStore: store,
  mode: "model",
  model,
  usingCachedEvents: false, // default is true; set false for partition-scoped async reads
});

await repositoryWithPartition.init({
  initialState: model.initialState,
});

// apply an event with partitions
await repositoryWithPartition.addEvent({
  type: "event",
  partitions: ["session-1"],
  payload: {
    schema: "explorer.folderCreated",
    data: { id: "2", name: "Session Folder" },
  },
});

// read the current state with partitions filter
const stateWithPartition = await repositoryWithPartition.getStateAsync({ partitions: ["session-1"] })
console.log(stateWithPartition);
```

## 🔄 How Insieme Differs from CRDTs

While Insieme is inspired by CRDTs (Conflict-Free Replicated Data Types), it uses an authoritative, event-based model rather than full distribution.

| Concept | CRDT | Insieme |
|---------|------|---------|
| **Authority** | Fully distributed — no central truth | Central authoritative server |
| **Validation** | No validation layer | Server validates and commits actions |
| **Action flow** | Direct peer merges | Optimistic drafts → server commit |
| **Conflict handling** | Complex merge rules | Last Write Wins (LWW), deterministic |
| **Offline mode** | Local replicas merge later | Optimistic drafts work offline, sync later |
| **Data structure** | Generic object graphs | Command/event model (tree adapter optional) |

🧠 **In short**: Insieme trades peer-to-peer autonomy for simplicity, validation, and predictability—delivering optimistic UIs and offline support with a single source of truth.

🧱 Architecture Overview

client
 ├─ drafts → local actions (optimistic)
 ├─ repo   → replays actions + checkpoints
 └─ sync → sends to server → gets committed actions

server
 ├─ validates and orders actions
 └─ returns committed actions with incremental IDs

## API Documentation

### Store Interface

The store interface defines the methods your storage adapter must implement. Required methods are mandatory, while optional methods enable additional features like persistent snapshots.

```js
const store = {
  // Required: Load all events with optional filtering
  async getEvents(payload) {
    // payload: {} | { partitions?: string[], since?: number }
    // - partitions: filter events by partition intersection
    // - since: load events after this index (for snapshot optimization)
    return []; // Array of events
  },

  // Required: Append a new event
  async appendEvent(event) {
    // event: { type, payload, partitions? }
    // Persist the event
  },

  // Optional: Load a persisted snapshot (enables fast initialization)
  async getSnapshot() {
    return {
      state: { /* current state */ },
      eventIndex: 1000,       // Number of events included in snapshot
      createdAt: 1234567890   // Timestamp when snapshot was created
    } | null;
  },

  // Optional: Persist a snapshot (enables fast initialization)
  async setSnapshot(snapshot) {
    // snapshot: { state, eventIndex, createdAt }
    // Persist the snapshot for fast loading
  }
};
```

Partition field migration:
- Canonical contract uses `partitions: string[]`.
- Legacy singular `partition` may be accepted only as a local compatibility shim; normalize to `partitions` immediately.

**Note**: Stores that don't implement snapshot methods will still work perfectly but won't benefit from fast initialization. The `since` parameter in `getEvents` is optional - if your store doesn't support it, Insieme will automatically load all events and slice them as needed.

### Repository Creation

```js
import { createRepository } from "insieme";

const store = {
  async getEvents() { return []; },
  async appendEvent(event) { console.log("saved", event); },
};

const model = {
  initialState: { user: { name: "" } },
  schemas: {
    "user.nameSet": {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  reduce(draft, event) {
    if (event.payload.schema === "user.nameSet") {
      draft.user.name = event.payload.data.value;
    }
  },
  version: 1,
};

const repository = createRepository({
  originStore: store,              // Required: Store implementation
  usingCachedEvents: true,         // Optional: Cache events in memory (default: true)
  snapshotInterval: 1000,          // Optional: Auto-save snapshot interval (default: 1000)
  mode: "model",                   // Canonical profile
  model,
});

await repository.init({
  initialState: model.initialState,
});

// apply an event
await repository.addEvent({
  type: "event",
  payload: {
    schema: "user.nameSet",
    data: { value: "Alice" },
  },
});

// read the current state
console.log(repository.getState());
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `originStore` | Store | *required* | Storage adapter implementing the store interface |
| `usingCachedEvents` | boolean | `true` | Cache events in memory for fast `getState()`. Set to `false` for partition support |
| `snapshotInterval` | number | `1000` | Auto-save snapshot every N events. Set to `0` to disable |
| `mode` | `"tree" \| "model"` | `"tree"` | Runtime mode. Use `"model"` for the canonical command/event interface |
| `model` | object | `undefined` | Model definition for `mode: "model"` (initialState, schemas, reduce, version) |

### Repository Methods

#### `init(options)`
Initialize the repository, loading from snapshot (if available) and replaying events.

```js
await repository.init({
  initialState: { /* ... */ }   // Optional: Initial state if no events exist
});
```

#### `addEvent(event)`
Append a new event to the event log.

```js
await repository.addEvent({
  type: "event",
  payload: {
    schema: "user.nameSet",
    data: { value: "Alice" }
  },
  partitions: ["session-1"]  // Optional
});
```

### Model Events (`type: "event"`) (Canonical Interface)
In `mode: "model"`, you send semantic command events through a stable envelope and
update state via an Immer reducer.

```js
const repository = createRepository({
  originStore: store,
  mode: "model",
  model: {
    initialState: { branches: { items: {}, tree: [] } },
    schemas: {
      "branch.create": {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false
      }
    },
    reduce(draft, event) {
      if (event.payload.schema === "branch.create") {
        const id = event.payload.data.name;
        draft.branches.items[id] = {};
        draft.branches.tree.push({ id, children: [] });
      }
    },
    version: 1
  }
});

await repository.addEvent({
  type: "event",
  payload: {
    schema: "branch.create",
    data: { name: "feature-x" }
  },
  partitions: ["branch/feature-x"]
});
```

**Notes:**
- Unknown event types are rejected during validation.
- Canonical profile: `type: "event"` only.
- Tree actions (`set`, `unset`, `tree*`) are a compatibility interface for legacy flows.

#### `getState(options)`
Get the current state or state at a specific event index.

```js
const currentState = repository.getState();
const stateAtEvent10 = repository.getState({ untilEventIndex: 10 });
```

#### `getEvents()`
Get all cached events (only available when `usingCachedEvents: true`).

```js
const events = repository.getEvents();
```

#### `getEventsAsync(payload)`
Get events from the store (useful for partition support).

```js
const allEvents = await repository.getEventsAsync();
const partitionEvents = await repository.getEventsAsync({ partitions: ["session-1"] });
```

#### `getStateAsync(options)`
Get state asynchronously (only available when `usingCachedEvents: false`).

```js
const state = await repository.getStateAsync({ partitions: ["session-1"] });
```

#### `saveSnapshot()`
Manually save a snapshot of the current state.

```js
await repository.saveSnapshot();
```

This is useful for creating snapshots at strategic points (e.g., before a deployment, after large imports). The repository will also automatically save snapshots based on the `snapshotInterval` configuration.

### Performance & Snapshots

Insieme uses event sourcing, which means it replays events to reconstruct state. For repositories with thousands of events, this can slow down initialization. **Persistent snapshots** solve this by periodically saving the computed state.

#### How Snapshots Work

Without snapshots:
```
Init → Load 13,727 events → Replay all (7.4s) → Ready
```

With snapshots (at event 13,000):
```
Init → Load snapshot (50ms) → Load 727 events → Replay (300ms) → Ready (total: 350ms)
```

**Result**: ~20x faster initialization for large repositories.

#### Snapshot Strategy

1. **Automatic snapshots**: Set `snapshotInterval: 1000` to save every 1,000 events
2. **Optimized loading**: Repository automatically loads latest snapshot on `init()`
3. **Fallback behavior**: If no snapshot exists, loads all events (existing behavior)
4. **Backwards compatible**: Stores without snapshot support work unchanged
5. **Model versioning**: If `model.version` is set, snapshots store `modelVersion`
   and are ignored when the version changes.

#### Performance Comparison

| Event Count | Without Snapshots | With Snapshots | Speedup |
|-------------|-------------------|----------------|---------|
| 1,000 | 500ms | 50ms | 10x |
| 10,000 | 5s | 100ms | 50x |
| 50,000 | 25s | 150ms | 166x |

*Based on typical JavaScript event replay performance*

#### Implementation Example

```js
// Store with snapshot support
const store = {
  async getEvents(payload) {
    // Support 'since' parameter for optimized loading
    if (payload && payload.since !== undefined) {
      return loadEventsFromFile(payload.since);
    }
    return loadEventsFromFile();
  },
  async appendEvent(event) { await appendToFile(event); },

  // Optional: Enable snapshots
  async getSnapshot() { return loadSnapshotFromFile(); },
  async setSnapshot(snapshot) { await saveSnapshotToFile(snapshot); }
};

const repository = createRepository({
  originStore: store,
  snapshotInterval: 1000  // Auto-save every 1000 events
});

// First init: slow (replays all events)
await repository.init();

// ... add events ...

// Second init: fast (loads snapshot + replays only new events)
await repository.init();
```

#### When to Use Snapshots

- **Large event logs** (>1,000 events)
- **Frequent restarts** (serverless, server restarts)
- **Slow event loading** (network/disk I/O bottlenecks)
- **Cold start optimization** (improve user experience)

Snapshots are optional but highly recommended for production applications with significant event history.


## Tree Compatibility Actions

These actions are maintained for compatibility with existing tree-mode integrations.

Canonical interface for new systems is model commands (`type: "event"`). If you use tree actions, prefer wrapping them behind a service-level command facade.

For dynamic-document apps, harden tree compatibility with:
- target/action whitelists,
- per target+action payload schemas,
- strict precondition checks,
- sandbox apply + post-state invariant validation before commit.

See `docs/protocol/validation.md#tree-compatibility-policy-dynamic-documents`.

Insieme stores tree data in a structure designed to minimize conflicts and support collaborative editing. The tree uses a Last Writer Wins approach rather than CRDT merging for simplicity and predictability.

### Data Structure

Each tree contains two parts:
- `items`: A flat object storing all node data by ID
- `tree`: A hierarchical array representing the tree structure

```yaml
targetKey:
  items:
    item1:
      id: item1
      name: Root Folder
      type: folder
    item2:
      id: item2
      name: Child File
      type: file
  tree:
    - id: item1
      children:
        - id: item2
          children: []
```

### Core Actions

#### `set`
Sets a value at a specific path in the state.

```js
await repository.addEvent({
  type: "set",
  payload: {
    target: 'user.profile.name',
    value: 'Alice Smith',
    options: { replace: false }
  }
})
```

**Options:**
- `replace: boolean` (default: false) - When true, replaces the entire value. When false, merges with existing objects.

**Before:**
```yaml
user:
  profile:
    name: John Doe
    email: john@example.com
```

**After:**
```yaml
user:
  profile:
    name: Alice Smith
    email: john@example.com
```

#### `unset`
Removes a value at a specific path in the state.

```js
await repository.addEvent({
  type: "unset",
  payload: {
    target: 'user.profile.email'
  }
})
```

**Before:**
```yaml
user:
  profile:
    name: Alice Smith
    email: john@example.com
```

**After:**
```yaml
user:
  profile:
    name: Alice Smith
```

### Tree Compatibility Actions

Tree action payloads and examples now live in the client protocol docs:

- `docs/client/tree-actions.md` → **Tree Compatibility Actions (Event Payloads)**
- `docs/client/drafts.md` → **Draft Lifecycle, Rebase, and Local View**
