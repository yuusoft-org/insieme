# Validation

This document defines server-side validation rules, event type constraints, and model versioning.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Server Authority

The server is authoritative: it **MUST** validate every event.

- Event profile (`canonical`): validate `event` envelope (`schema`, `data`, optional `meta`) and schema payloads.
- Tree profile (`compatibility`): validate tree payloads and preserve tree semantics (see [Tree Operation Edge Cases](../client/tree-actions.md#tree-operation-edge-cases)).

## Valid Event Types

Top-level `event.type` values for sync submissions (`submit_events`):

- Event profile (`canonical`): `event` (with envelope: `schema`, `data`, optional `meta`)
- Tree profile (`compatibility`): `set`, `unset`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`
- `init` is a repository-local bootstrap event and is not part of the sync wire protocol.

### Mode Constraints

- Servers **MUST** enforce the negotiated connection profile from `connected.payload.capabilities.profile`.
- Submitted `event.type` **MUST** be one of `connected.payload.capabilities.accepted_event_types`.
- Event profile servers **MUST** reject non-`event` types.
- Tree profile servers **MUST** reject non-tree action types.
- In tree profile (`compatibility`), negotiated `tree_policy` **MUST** be `strict` per this spec.
- Server **MUST** reject wire submissions with `event.type=init` using `validation_failed`.

## Batch Validation

For `submit_events` (batch submit):

- `payload.events` **MUST** be a non-empty array.
- `payload.events[].id` values **MUST** be unique within the request.
- Legacy singular `payload.events[].partition` **MUST NOT** be accepted. If present, server **MUST** reject the request with `bad_request`.
- Duplicate ids inside a single batch **MUST** cause whole-request rejection with `bad_request` before processing any item.
- Server **MUST** process `payload.events` in list order.
- Each item is validated against state resulting from prior committed items in the same batch.
- Batch processing is **non-atomic**: partial success is allowed.
- A rejection of item `N` **MUST NOT** roll back committed results for items `< N`.
- Committed items from the same batch **MUST** preserve list order in `committed_id` ordering.
- Max batch size default: 100 events. If overridden, server **SHOULD** advertise `limits.max_batch_size` in `connected`.
- Each committed item still generates individual `event_broadcast` messages for subscribed peers.

## Tree Profile Rule

If tree profile is enabled, both client and server **MUST** reject `treeMove` where the target parent is a descendant of the moved node (`validation_failed`), preventing orphaning caused by self-descendant moves.

## Tree Profile Policy (Dynamic Documents)

For dynamic-document apps using tree profile, servers **MUST** enforce a policy-driven gate before commit:

1. `target` whitelist:
   - Server **MUST** allow only registered tree targets.
   - Unknown targets **MUST** be rejected with `validation_failed`.
2. Action whitelist per target:
   - Server **MUST** define allowed actions per target (`set`, `unset`, `treePush`, `treeDelete`, `treeUpdate`, `treeMove`).
   - Disallowed actions **MUST** be rejected with `validation_failed`.
3. Payload schema per (`target`, `action`):
   - Server **MUST** validate payload shape and constraints against the registered schema.
4. Transition preconditions:
   - `treePush`: reject duplicate `value.id`; reject nonexistent `options.parent` (except `_root`); reject invalid `before/after` sibling references.
   - `treeUpdate`: reject nonexistent `options.id`.
   - `treeDelete`: reject nonexistent `options.id` when strict tree policy is enabled.
   - `treeMove`: reject nonexistent moved id, nonexistent target parent (except `_root`), invalid sibling references, and self/descendant moves.
5. Simulated apply:
   - Server **MUST** apply the candidate event to a sandbox copy of the authoritative state (including prior successful items in the same batch), not mutate committed state directly.
6. Post-state invariant validation:
   - Server **MUST** validate resulting tree invariants before commit:
     - acyclic tree,
     - every tree node id exists in `items`,
     - every `items` id referenced by policy as non-orphaned appears in exactly one tree location,
     - no duplicate node ids in tree.
7. Commit gate:
   - Event **MUST** be committed only if all checks above pass.
   - On failure, server **MUST** return `validation_failed` with deterministic `errors[].field` paths and messages.
8. Authorization gate:
   - Server **MUST** verify partition/resource authorization before commit.
   - Unauthorized events **MUST** be rejected with `forbidden`.

Notes:
- This policy intentionally tightens historical tree runtime behavior (silent no-op/orphan cases) for production robustness.
- Clients **SHOULD** run equivalent local prechecks for fast UX, but server validation remains authoritative.

## Model Versioning

- Server **MUST** expose `model_version` in `connected` and `sync_response` for event profile deployments.
- Protocol `1.0` does not use a dynamic `version_changed` push message.
- Model/schema upgrades are deployment-driven: client code/runtime version is updated out-of-band.
- If a client observes `model_version` different from its local snapshot/model version, it **MUST** invalidate local model snapshots and perform full re-sync for all active model partitions (`since_committed_id=0`).
