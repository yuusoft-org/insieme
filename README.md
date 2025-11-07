
# Insieme

**Insieme** (Italian for *“together”*) is a foundational library for building **collaborative, consistent state**.
It provides a deterministic, event-based core for syncing application state across clients and a central authoritative server

---

## ✨ Features

- 🔁 **Offline-first** - Works offline and syncs when network is available
- 🧱 **Validation** - central server commits and validates changes.
- 💾 **Swappable storage adapters** — works in browser, desktop, or custom stores.

---

## 🚀 Quick Start

```js
import { createRepository } from "insieme";

const initialState = {
  explorer: { items: {}, tree: [] },
};

const repository = createRepository({
  initialState,
  draftStore: ...,
  sourceStore: ...,
  remoteAdapater: ...,
})

// apply an action
await repository.addAction({
  actionType: "treePush",
  target: "explorer",
  value: { id: "1", name: "New Folder", type: "folder" },
  options: { parent: "_root" }
});

// read the current state
console.log(repository.getState());
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

### Creation

```js
import { createRepository } from "insieme";

const store = {
  async getAllEvents() { return []; },
  async addAction(action) { console.log("saved", action); },
  app: {
    get: async (k) => localStorage.getItem(k),
    set: async (k, v) => localStorage.setItem(k, v),
    remove: async (k) => localStorage.removeItem(k),
  },
};

const initialState = {
  explorer: { items: {}, tree: [] },
};

const adapter = (subject) => {
  const ws = new Websockert(...)

  ws.on('...', () => {
    subject.receivedFromRemote(...)
  })

  return {
    sendToRemote: (payload) => {
      ws.send(payload)
    },
  }
}

const repository = createRepository({
  initialState,
  draftStore: ...,
  sourceStore: ...,
  sourceMode: true
})

// apply an action
await repository.addAction({
  actionType: "treePush",
  target: "explorer",
  value: { id: "1", name: "New Folder", type: "folder" },
  options: { parent: "_root" }
});

// read the current state
console.log(repository.getState());
```


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
await repository.set({
  target: 'user.profile.name',
  value: 'Alice Smith',
  options: { replace: false }
})
```

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
await repository.unset({
  target: 'user.profile.email'
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
await repository.treePush({
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
await repository.treeDelete({
  target: 'explorer',
  options: {
    id: 'folder1'
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
await repository.treeUpdate({
  target: 'explorer',
  value: {
    name: 'Renamed Folder',
    type: 'folder'
  },
  options: {
    id: 'folder1',
    replace: false
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
await repository.treeMove({
  target: 'explorer',
  options: {
    id: 'file1',
    parent: 'folder2',
    position: 'first'
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

