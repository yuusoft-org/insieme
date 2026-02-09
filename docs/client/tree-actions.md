# Tree Actions

This document defines the tree data structure and tree mode event types: `treePush`, `treeDelete`, `treeUpdate`, `treeMove`, and their edge cases.

These apply when using **tree mode** (event `type` is one of the tree actions).

## Tree Data Structure

Each `target` key contains:

- `items`: flat object indexed by item id
- `tree`: hierarchical array of node ids + children

Example:
```yaml
explorer:
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

## `treePush`

Adds a new item to the tree under a parent.

```yaml
type: treePush
payload:
  target: explorer
  value:
    id: folder1
    name: New Folder
    type: folder
  options:
    parent: _root
    position: first
```

Options:
- `parent`: parent id (default `_root`)
- `position`: `first` | `last` | `{ after: "<id>" }` | `{ before: "<id>" }` (default `first`)

## `treeDelete`

Removes an item and all its children.

```yaml
type: treeDelete
payload:
  target: explorer
  options:
    id: folder1
```

## `treeUpdate`

Updates properties of an existing item.

```yaml
type: treeUpdate
payload:
  target: explorer
  value:
    name: Renamed Folder
    type: folder
  options:
    id: folder1
    replace: false
```

Options:
- `id`: item id to update
- `replace`: when true, replaces the entire item; otherwise merges (default false)

## `treeMove`

Moves an item to a new parent or position.

```yaml
type: treeMove
payload:
  target: explorer
  options:
    id: file1
    parent: folder2
    position: first
```

Options:
- `id`: item id to move
- `parent`: new parent id (use `_root` for root) (default `_root`)
- `position`: `first` | `last` | `{ after: "<id>" }` | `{ before: "<id>" }` (default `first`)

## Tree Operation Edge Cases

Server implementations must match these exact semantics to avoid state divergence:

- **`treePush` to nonexistent parent**: the item is added to `items` but not inserted into `tree`. The item becomes orphaned. No error is thrown.
- **`treeUpdate` on nonexistent item**: the value is written as a new entry in `items` (spread of undefined + value). No error is thrown.
- **`treeDelete` on nonexistent item**: silent no-op. No error is thrown.
- **`treeMove` on nonexistent item**: silent no-op, state is returned unchanged. No error is thrown.
- **`treeMove` into own descendant**: the node is removed from the tree during the move, then the target parent (which was a descendant) is no longer found. The node and all its descendants silently disappear from `tree` but remain in `items` as orphans. **This should be prevented by validation** — both client and server should reject `treeMove` where the target parent is a descendant of the moved node.
