# Collaborative Text Editing (Future Extension Draft)

This is a design draft for future consideration. It is not part of the current protocol or implementation.

## Motivation

Insieme currently operates at the event/action level — discrete operations like "add item", "update field", "move node". This works well for structural collaboration but does not cover character-level text editing, where users expect sub-100ms feedback on every keystroke and concurrent edits must merge gracefully.

The motivation doc states Insieme is "not a real-time text editor" and recommends using a dedicated library (Yjs, Automerge) for text. That remains the recommended approach today. However, integrating two separate collaboration systems is complex in practice — two sync protocols, two conflict resolution strategies, two offline queues, two state management layers. The integration surface is where bugs live.

This document explores how Insieme could natively support collaborative text editing in the future without requiring a second collaboration system.

## Why OT Over CRDT

Insieme already has an authoritative server with total ordering (`committed_id`). This is exactly what OT (Operational Transformation) needs and exactly what CRDTs were designed to avoid needing.

Using a CRDT for text inside Insieme would mean paying the CRDT complexity tax (tombstones, character-level unique IDs, causal metadata) for a benefit Insieme doesn't need (serverless merge).

### OT advantages in Insieme's context

- **Simpler operations.** `insert(position, text)` and `delete(position, length)`. The transform function is small and well-understood.
- **Server decides.** The server receives operations, transforms them against concurrent committed ones, and broadcasts the result. This fits the existing `submit_events` → validate → result/broadcast flow.
- **Smaller payloads.** OT operations are compact (position + text). CRDT operations carry unique IDs per character and causal metadata. For batched operations sent every 500ms, payload size matters.
- **No tombstones.** CRDTs keep deleted characters as hidden state forever (or need garbage collection). OT does not.
- **Central server simplifies OT.** Classic distributed OT (Google Wave) was notoriously hard because operation ordering was ambiguous and transform functions had to compose across N peers. Insieme's `committed_id` gives a total order, and the server is the single transform authority — no peer-to-peer transform chains.

### What CRDTs offer that we'd give up

- **Peer-to-peer sync.** Irrelevant — Insieme is server-authoritative by design.
- **Automatic offline merge.** With OT, offline edits must be transformed by the server on reconnect. But Insieme already rebases offline drafts on committed state — OT transforms during rebase are the text-specific version of what Insieme already does.

## Proposed Design

### New event type: `textEdit`

A `textEdit` event targets a specific text field and contains a batch of OT operations.

```yaml
type: textEdit
payload:
  target: doc.body
  base_committed_id: 1200
  ops:
    - type: insert
      position: 5
      text: hello
    - type: delete
      position: 20
      length: 3
```

- `target`: path to the text field in state (same targeting as `set`).
- `base_committed_id`: the last `committed_id` the client had applied to this field when generating the operations. The server uses this to determine which concurrent operations to transform against.
- `ops`: ordered list of OT operations.

### Client behavior

1. Keystrokes are applied to local state immediately (no server round-trip per character).
2. Operations are batched (e.g., every 500ms or on typing pause).
3. The batch is submitted as a single `textEdit` event through the normal Insieme draft pipeline.
4. On receiving committed `textEdit` events from other clients, apply the transformed operations to local state.

### Server behavior

1. Receive `textEdit` event.
2. Look up concurrent committed `textEdit` operations on the same `target` since `base_committed_id`.
3. Transform the submitted operations against all concurrent ones.
4. If the transform succeeds, commit the transformed operations with a new `committed_id`.
5. Broadcast the transformed operations to other clients.

The server is the single transform authority. Clients send raw operations; the server resolves conflicts.

### Merge strategy routing

`textEdit` events use OT merge, not LWW. All other event types continue to use LWW.

The server must route merge strategy by event type:
- `set`, `unset`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`: LWW (existing behavior).
- `textEdit`: OT transform.

This means the protocol needs a way for the server to distinguish merge strategies. Since it's determined by event type, no additional field is needed — `textEdit` implicitly means OT.

### Offline reconnect

When a client reconnects with pending `textEdit` drafts:

1. Client submits the drafts in `draft_clock` order (same as today).
2. Server transforms each against all committed operations since the draft's `base_committed_id`.
3. If the transform succeeds, commit and broadcast.
4. If the text field has changed so much that the transform is ambiguous or the position is invalid, reject the event and let the client re-sync and retry.

This follows the existing draft rebase pattern.

## What this does NOT cover

- **Cursor and selection sync (presence).** This is ephemeral state, not part of the event log. It should use a separate lightweight channel (e.g., broadcast-only WebSocket messages with no persistence). This is a separate design concern.
- **Rich text formatting.** OT for rich text (bold, italic, headings) adds complexity. The initial design should target plain text. Rich text support can be layered on later using attributed ranges or a Peritext-style model.
- **Undo/redo across transformed operations.** OT undo in a collaborative context is a known hard problem. Initial implementation can use local-only undo (undo your own operations, not others').

## Open questions

- **Batching interval.** 500ms is a starting point. Shorter intervals reduce apparent latency for remote users but increase event volume. This may need to be adaptive.
- **Max operation batch size.** Large paste operations could create very large `textEdit` payloads. Should there be a limit? Should large pastes be split into multiple events?
- **Snapshot representation.** Should text field snapshots store the full string, or store it as an OT-compatible base document? Full string is simpler for snapshots; OT state is only needed for the transform window.
- **Transform window pruning.** The server only needs to keep recent operations for transform (since the oldest connected client's `base_committed_id`). How to manage this efficiently needs design.
- **Granularity.** Should `textEdit` support targeting nested fields (e.g., `items.doc1.body`) or only top-level state keys?

## Current recommendation

Use Insieme for structural collaboration (tree profile for free-form structures and/or event profile for schema-driven commands) and integrate a dedicated text library (Yjs, Automerge) for character-level editing. This is the proven approach used by production apps like Notion and Linear.

If the integration complexity becomes a real problem for Insieme users, this design provides a path to native text support without requiring a second collaboration system. The protocol is designed to allow this extension — `textEdit` is a new event type with a different merge strategy, not a change to existing semantics.
