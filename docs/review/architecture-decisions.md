# Architecture Decisions (Frozen)

Decision date: February 13, 2026

## AD-001: Transport Boundary

- Client runtime depends on pluggable transport with:
  - `connect()`, `disconnect()`, `send(message)`, `onMessage(handler)`.
- Protocol framing remains `type` + `payload` + `protocol_version`.

## AD-002: Client Store Boundary (Simplified)

- Store interface is transactional at domain boundaries:
  - `insertDraft`
  - `loadDraftsOrdered`
  - `applySubmitResult`
  - `applyCommittedBatch`
  - `loadCursor`
- Client runtime must not orchestrate row-level draft/commit/cursor steps.

## AD-003: Server Commit Boundary

- Server storage provides atomic `commitOrGetExisting` behavior for submit path.
- Dedupe key is event `id`.
- Commit ordering invariant: assign `committed_id` -> durable persist -> reply/broadcast.

## AD-004: Cursor and Paging

- Sync uses exclusive `since_committed_id`.
- `next_since_committed_id` is the cursor handoff across pages.
- Server uses fixed per-cycle `sync_to_committed_id` to guarantee paging convergence.
- Client persists final cursor when `has_more=false` (intermediate persists allowed).

## AD-005: Partition Semantics

- Canonical field is `partitions: string[]`.
- Duplicates are rejected.
- Accepted sets are normalized lexicographically for deterministic equality and storage.

## AD-006: Canonical Payload Equality

- Canonicalization input: `{ partitions: normalizedPartitions, event }`.
- Use deep key-sorted JSON serialization for deterministic equality.
- Same `id` + different canonical payload is rejected (`validation_failed`).

## AD-007: Compatibility Boundary

- Legacy repository API `partition` may be accepted only as compatibility shim.
- New/updated protocol-facing and sync-facing APIs are `partitions`-first.
