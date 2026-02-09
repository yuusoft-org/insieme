# Validation

This document defines server-side validation rules, event type constraints, and model versioning.

## Server Authority

The server is authoritative: it **must** validate every event.

- For **model mode**, validate the event envelope and schema (same rules as the client).
- For **tree mode**, validate the action payloads. The server must implement the same tree operation semantics as the client library (see [Tree Operation Edge Cases](../client/tree-actions.md#tree-operation-edge-cases)).

## Valid Event Types

Top-level `event.type` values:

- Tree mode: `set`, `unset`, `init`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`
- Model mode: `event` (with envelope: `schema`, `data`, optional `meta`)

### Mode Constraints

- Tree mode must reject `event` type.
- Model mode must reject non-`event` types except `init` if explicitly enabled.

## Batch Validation

For `submit_events` (batch submit):

- Server must process `payload.events` in list order.
- Each item is validated against state resulting from prior committed items in the same batch.
- Max batch size: 100 events (server configurable).
- Each committed item still generates individual `event_broadcast` messages for subscribed peers.

## Model Versioning

- Server must expose `model_version` in `connected` and `sync_response` (when in model mode).
- If the model version changes while clients are connected, server must send `version_changed`.
- On receiving `version_changed`, clients must invalidate snapshots and full re-sync.
