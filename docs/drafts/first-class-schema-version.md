# First-Class `schemaVersion` On Events (Future Draft)

This is a design draft for future consideration. It is not part of the current protocol or implementation.

## Intent

Add a first-class `schemaVersion` field to canonical Insieme event objects so applications can version their persisted command/event contracts without hiding that version inside `meta` or `payload`.

The field should be preserved across:
- local draft storage,
- `submit_events`,
- authoritative committed storage,
- client handling of `submit_events_result` via draft/result correlation by `id`,
- `event_broadcast`,
- `sync_response.events`,
- committed-event replay.

## Recommendation

- Add `schemaVersion` as a top-level event field.
- Make it required on submitted and committed events.
- Apply the requirement at the core sync-event layer, not only in command-profile helpers.
- Validate it structurally in Insieme.
- Preserve it exactly in all stores and protocol messages.
- Include it in canonical equality for same-`id` dedupe checks.
- Keep version semantics app-owned:
  - Insieme validates that the field exists and is well-formed.
  - The application model decides whether a given `schemaVersion` is supported for a given `type`.

## Scope

This proposal applies to the canonical event object handled by the low-level sync client API:
- `createSyncClient().submitEvents([...])`
- `createSyncClient().submitEvent(...)`

Higher-level helpers such as the command session should map commands onto that same event shape and populate/pass through `schemaVersion` there. This is not intended to be command-only metadata.

## Why Top-Level

`schemaVersion` should not live in `meta` because:
- it is part of the canonical event contract, not tracing/debug metadata,
- it affects replay and validation semantics,
- it should be queryable and inspectable in storage without opening JSON blobs,
- same `id` with different `schemaVersion` must not be treated as the same logical event.

It should not live in `payload` because:
- the version describes the payload contract itself,
- putting it inside the payload creates circular schema rules,
- storage and transport code should not need app-specific payload knowledge to preserve it.

## Proposed Shapes

### Submitted Event

```yaml
type: submit_events
protocolVersion: "1.0"
payload:
  events:
    - id: evt-uuid-1
      partitions: [workspace-1]
      projectId: workspace-1
      userId: user-123
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: A, name: Folder A }
      meta:
        clientId: client-123
        clientTs: 1738451200000
```

### Broadcast Event

```yaml
type: event_broadcast
protocolVersion: "1.0"
payload:
  committedId: 1201
  id: evt-uuid-1
  partitions: [workspace-1]
  projectId: workspace-1
  userId: user-123
  type: explorer.folderCreated
  schemaVersion: 1
  payload: { id: A, name: Folder A }
  meta:
    clientId: client-123
    clientTs: 1738451200000
  created: 1738451205000
```

### Sync Response Event

```yaml
type: sync_response
protocolVersion: "1.0"
payload:
  partitions: [workspace-1]
  events:
    - committedId: 1201
      id: evt-uuid-50
      partitions: [workspace-1]
      projectId: workspace-1
      userId: user-456
      type: explorer.folderCreated
      schemaVersion: 1
      payload: { id: B, name: Folder B }
      meta:
        clientId: client-456
        clientTs: 1738451200000
      created: 1738451200000
  nextSinceCommittedId: 1700
  hasMore: false
  syncToCommittedId: 1700
```

## Field Rules

- `schemaVersion` **MUST** be a positive integer.
- `schemaVersion` **MUST** be present on each event submitted through the low-level sync client API.
- `schemaVersion` **MUST** be present on each committed event returned by sync/broadcast APIs.
- `schemaVersion` **MUST** round-trip unchanged through client and server storage.
- `schemaVersion` **MUST NOT** be rewritten into `meta`.
- `schemaVersion` **MUST NOT** be inferred from `type`.
- `submit_events_result` items **MUST NOT** grow a `schemaVersion` field; clients correlate submit outcomes by `id`.
- Insieme **MUST NOT** interpret the meaning of version numbers beyond shape/preservation rules.

## Validation Boundary

Insieme should validate:
- event object contains `schemaVersion`,
- value is a positive integer,
- storage and replay preserve the same value.

Applications should validate:
- whether `schemaVersion` is supported for the submitted `type`,
- whether the payload is valid for that version,
- whether replay of older versions requires migration or rejection.

Command/session helpers should:
- populate or pass through `schemaVersion` before delegating to the low-level sync client,
- avoid introducing a separate version field with competing meaning.

Recommended failure split:
- malformed or missing `schemaVersion`: `validation_failed`,
- unsupported app-owned `schemaVersion`: also `validation_failed` from the app validation hook.

## Dedupe / Canonicalization

Current same-`id` dedupe compares canonical event content. `schemaVersion` must become part of that comparison.

That means:
- same `id` + same `schemaVersion` + same canonical content => return existing commit,
- same `id` + different `schemaVersion` => reject as different payload/contract,
- same `id` + same `payload` but different `schemaVersion` => still reject.

## Storage Impact

If this field is truly first-class, it should not be stored only inside `payload` or `meta` JSON blobs.

Recommended persisted shape:

### Client Draft Storage

- `schema_version INTEGER NOT NULL`

### Client Committed Storage

- `schema_version INTEGER NOT NULL`

### Server Committed Storage

- `schema_version INTEGER NOT NULL`

The exact SQL/backing-store details can vary by adapter, but the field should be represented explicitly in the normalized store shape.

## Runtime Touchpoints

Implementation will need coordinated changes across the event normalization and storage path.

Primary files to update:
- `src/command-profile.js`
  - `commandToSyncEvent()` should populate/pass through `schemaVersion`
  - `committedSyncEventToCommand()` should preserve it when mapping back to app envelopes
  - `validateCommandSubmitItem()`
- `src/event-record.js`
  - `normalizeSubmitEventInput()`
  - `buildCommittedEventFromDraft()`
- `src/canonicalize.js`
  - include `schemaVersion` in canonical equality
- `src/sync-client.js`
  - preserve `schemaVersion` in local draft/submit/retry flow
- `src/sync-server.js`
  - validate presence/shape before commit
- Client stores
  - `src/in-memory-client-store.js`
  - `src/indexeddb-client-store.js`
  - `src/sqlite-client-store.js`
  - `src/libsql-client-store.js`
- Server stores
  - `src/sqlite-sync-store.js`
  - `src/libsql-sync-store.js`
- Docs
  - `docs/protocol/messages.md`
  - `docs/protocol/validation.md`
  - `docs/client/storage.md`
  - `docs/reference/javascript-interface.md`

## Rollout Notes

This is a breaking contract change once submit validation requires `schemaVersion`.

Recommended rollout assumptions:
- treat this as a coordinated client/server upgrade,
- do not provide backward compatibility for historical drafts or committed rows that lack `schemaVersion`,
- require storage migration, reset, or explicit backfill before enabling the new validation rules,
- bump storage schema versions where needed,
- treat old clients that omit `schemaVersion` as incompatible after rollout,
- prefer a package semver major release when enforcing the new requirement.

This draft does not require changing websocket `protocolVersion` by itself, but it does tighten the event contract and persistence shape.

## Non-Goals

- Defining application-specific model migration rules.
- Negotiating supported schema versions over the wire.
- Making Insieme responsible for payload migration.
- Hiding the field inside `meta` as a compatibility shortcut.
- Preserving compatibility with persisted events that predate `schemaVersion`.

## Implementation Checklist

1. Add `schemaVersion` to normalized event objects.
2. Validate it in submit-item normalization/validation.
3. Persist it in all client draft and committed stores.
4. Persist it in server committed stores.
5. Include it in canonical same-`id` equality.
6. Return it in `event_broadcast` and `sync_response.events`.
7. Preserve it when converting committed events back to app command envelopes.
8. Update protocol and storage docs after runtime support lands.
9. Add tests for:
   - missing `schemaVersion`,
   - non-integer `schemaVersion`,
   - replay round-trip preservation,
   - same `id` with different `schemaVersion`,
   - sync/broadcast emission including `schemaVersion`.
