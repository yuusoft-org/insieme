# Tree Actions

This document defines the tree data structure and tree profile event types: `treePush`, `treeDelete`, `treeUpdate`, `treeMove`, and their edge cases.

Tree actions are a **first-class interface** for dynamic/free-form documents. The event profile (`type: event`) is also first-class for stricter schema-driven domains.

These rules apply when tree profile support is enabled (event `type` is one of the tree actions).

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

For robust deployments, validate and reject invalid operations in the command layer before they are translated into tree actions.

- **`treePush` to nonexistent parent**: the item is added to `items` but not inserted into `tree`. The item becomes orphaned. No error is thrown.
- **`treeUpdate` on nonexistent item**: the value is written as a new entry in `items` (spread of undefined + value). No error is thrown.
- **`treeDelete` on nonexistent item**: silent no-op. No error is thrown.
- **`treeMove` on nonexistent item**: silent no-op, state is returned unchanged. No error is thrown.
- **`treeMove` into own descendant**: the node is removed from the tree during the move, then the target parent (which was a descendant) is no longer found. The node and all its descendants silently disappear from `tree` but remain in `items` as orphans. **Both client and server must reject this with `validation_failed`** before applying the operation.

## Recommended Guardrails (Tree Profile Deployments)

For dynamic-document production deployments, use the strict tree policy from [protocol/validation.md](../protocol/validation.md#tree-profile-policy-dynamic-documents):

- whitelist valid `target` values,
- whitelist allowed actions per target,
- validate payload by (`target`, `action`) schema,
- run strict precondition checks,
- simulate apply on sandbox state,
- validate post-state invariants before commit.

This keeps tree operations deterministic and safe for first-class dynamic data use.
