
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

## 🚀 Quick Start

```js
import { createRepository } from "insieme";

const store = {
  async getEvents(payload) {  
    console.log(payload);  // should be {} or { partition: ... }
    return []; 
  },
  async appendEvent(event) { 
    console.log("saved", event);  // should be { type: ..., payload: {...} } or { type: ..., partition: ..., payload: {...} }
  },
};

const repository = createRepository({
  originStore: store
});

const initialState = {
  explorer: { items: {}, tree: [] },
};

await repository.init({
  initialState
});

// apply an event
await repository.addEvent({
  type: "treePush",
  payload: {
    target: "explorer",
    value: { id: "1", name: "New Folder", type: "folder" },
    options: { parent: "_root" }
  }
});

// read the current state
console.log(repository.getState());

const repositoryWithPartition = createRepository({
  originStore: store,
  usingCachedEvents: false  // this default true, should be false when need partition
});

await repositoryWithPartition.init({
  initialState
});

// apply an event with partition
await repository.addEvent({
  type: "treePush",
  partition: "session-1",
  payload: {
    target: "explorer",
    value: { id: "1", name: "New Folder", type: "folder" },
    options: { parent: "_root" }
  }
});

// read the current state with partition
const stateWithPartition = await repository.getStateAsync({ partition: "session-1" })
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
| **Data structure** | Generic object graphs | Tree-based state with granular updates |

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
    // payload: {} | { partition?: string, since?: number }
    // - partition: filter events by partition
    // - since: load events after this index (for snapshot optimization)
    return []; // Array of events
  },

  // Required: Append a new event
  async appendEvent(event) {
    // event: { type, payload, partition? }
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

**Note**: Stores that don't implement snapshot methods will still work perfectly but won't benefit from fast initialization. The `since` parameter in `getEvents` is optional - if your store doesn't support it, Insieme will automatically load all events and slice them as needed.

### Repository Creation

```js
import { createRepository } from "insieme";

const store = {
  async getEvents() { return []; },
  async appendEvent(event) { console.log("saved", event); },
};

const repository = createRepository({
  originStore: store,              // Required: Store implementation
  usingCachedEvents: true,         // Optional: Cache events in memory (default: true)
  snapshotInterval: 1000           // Optional: Auto-save snapshot interval (default: 1000)
});

const initialState = {
  explorer: { items: {}, tree: [] },
};

await repository.init({
  initialState
});

// apply an event
await repository.addEvent({
  type: "treePush",
  payload: {
    target: "explorer",
    value: { id: "1", name: "New Folder", type: "folder" },
    options: { parent: "_root" }
  }
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

### Repository Methods

#### `init(options)`
Initialize the repository, loading from snapshot (if available) and replaying events.

```js
await repository.init({
  initialState: { /* ... */ },  // Optional: Initial state if no events exist
  partition: "session-1"        // Optional: Partition identifier
});
```

#### `addEvent(event)`
Append a new event to the event log.

```js
await repository.addEvent({
  type: "set",
  payload: {
    target: "user.name",
    value: "Alice"
  },
  partition: "session-1"  // Optional
});
```

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
const partitionEvents = await repository.getEventsAsync({ partition: "session-1" });
```

#### `getStateAsync(options)`
Get state asynchronously (only available when `usingCachedEvents: false`).

```js
const state = await repository.getStateAsync({ partition: "session-1" });
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


## Actions

Insieme stores data in a tree structure designed to minimize conflicts and support collaborative editing. The tree uses a Last Writer Wins approach rather than CRDT merging for simplicity and predictability.

### Data Structure

Each tree contains two parts:
- `items`: A flat object storing all node data by ID
- `tree`: A hierarchical array representing the tree structure

```json
{
  "targetKey": {
    "items": {
      "item1": {
        "id": "item1",
        "name": "Root Folder",
        "type": "folder"
      },
      "item2": {
        "id": "item2",
        "name": "Child File",
        "type": "file"
      }
    },
    "tree": [{
      "id": "item1",
      "children": [{
        "id": "item2",
        "children": []
      }]
    }]
  }
}
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

**Options:**
- `replace: boolean` (default: false) - When true, replaces the entire value. When false, merges with existing objects.

**Before:**
```json
{
  "user": {
    "profile": {
      "name": "John Doe",
      "email": "john@example.com"
    }
  }
}
```

**After:**
```json
{
  "user": {
    "profile": {
      "name": "Alice Smith",
      "email": "john@example.com"
    }
  }
}
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
```json
{
  "user": {
    "profile": {
      "name": "Alice Smith",
      "email": "john@example.com"
    }
  }
}
```

**After:**
```json
{
  "user": {
    "profile": {
      "name": "Alice Smith"
    }
  }
}
```

### Tree Actions

#### `treePush`
Adds a new item to the tree at a specified parent.

```js
await repository.addEvent({
  type: "treePush",
  payload: {
    target: 'explorer',
    value: {
      id: 'folder1',
      name: 'New Folder',
      type: 'folder'
    },
    options: {
      parent: '_root',
      position: 'last'
    }
  }
})
```

**Options:**
- `parent: string` - The parent ID where the item should be added (default: "_root" for root level)
- `position: string|object` - Position specification:
  - `"first"` - Add as first child
  - `"last"` - Add as last child (default)
  - `{ after: "itemId" }` - Add after specified sibling
  - `{ before: "itemId" }` - Add before specified sibling

**Before:**
```json
{
  "explorer": {
    "items": {},
    "tree": []
  }
}
```

**After:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "New Folder",
        "type": "folder"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": []
    }]
  }
}
```

#### `treeDelete`
Removes an item and all its children from the tree.

```js
await repository.addEvent({
  type: "treeDelete",
  payload: {
    target: 'explorer',
    options: {
      id: 'folder1'
    }
  }
})
```

**Before:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "New Folder",
        "type": "folder"
      },
      "file1": {
        "id": "file1",
        "name": "Child File",
        "type": "file"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": [{
        "id": "file1",
        "children": []
      }]
    }]
  }
}
```

**After:**
```json
{
  "explorer": {
    "items": {},
    "tree": []
  }
}
```

#### `treeUpdate`
Updates properties of an existing item in the tree.

```js
await repository.addEvent({
  type: "treeUpdate",
  payload: {
    target: 'explorer',
    value: {
      name: 'Renamed Folder',
      type: 'folder'
    },
    options: {
      id: 'folder1',
      replace: false
    }
  }
})
```

**Options:**
- `id: string` - The ID of the item to update
- `replace: boolean` (default: false) - When true, replaces entire item data. When false, merges with existing properties.

**Before:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "New Folder",
        "type": "folder"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": []
    }]
  }
}
```

**After:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "Renamed Folder",
        "type": "folder"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": []
    }]
  }
}
```

#### `treeMove`
Moves an item to a new parent in the tree.

```js
await repository.addEvent({
  type: "treeMove",
  payload: {
    target: 'explorer',
    options: {
      id: 'file1',
      parent: 'folder2',
      position: 'first'
    }
  }
})
```

**Options:**
- `id: string` - The ID of the item to move
- `parent: string` - The new parent ID (use "_root" for root level)
- `position: string|object` - Position specification:
  - `"first"` - Move as first child (default)
  - `"last"` - Move as last child
  - `{ after: "itemId" }` - Move after specified sibling
  - `{ before: "itemId" }` - Move before specified sibling

**Before:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "Folder 1",
        "type": "folder"
      },
      "folder2": {
        "id": "folder2",
        "name": "Folder 2",
        "type": "folder"
      },
      "file1": {
        "id": "file1",
        "name": "File 1",
        "type": "file"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": [{
        "id": "file1",
        "children": []
      }]
    }, {
      "id": "folder2",
      "children": []
    }]
  }
}
```

**After:**
```json
{
  "explorer": {
    "items": {
      "folder1": {
        "id": "folder1",
        "name": "Folder 1",
        "type": "folder"
      },
      "folder2": {
        "id": "folder2",
        "name": "Folder 2",
        "type": "folder"
      },
      "file1": {
        "id": "file1",
        "name": "File 1",
        "type": "file"
      }
    },
    "tree": [{
      "id": "folder1",
      "children": []
    }, {
      "id": "folder2",
      "children": [{
        "id": "file1",
        "children": []
      }]
    }]
  }
}
```