# JavaScript Interface (Client + Backend)

This file defines a minimal JS API surface aligned with the simplified core protocol.

- functions/factories only,
- storage and transport are pluggable,
- wire semantics are normative in `docs/protocol/*.md`.

## Shared Data Shapes

```js
/**
 * @typedef {Object} SubmitItem
 * @property {string} id
 * @property {string[]} partitions
 * @property {string} [projectId]
 * @property {string} [userId]
 * @property {string} type
 * @property {number} schemaVersion
 * @property {object} payload
 * @property {{ clientId: string, clientTs: number, [key: string]: any }} meta
 * @property {number} createdAt
 */

/**
 * @typedef {Object} CommittedEvent
 * @property {number} committedId
 * @property {string} id
 * @property {string[]} partitions
 * @property {string} [projectId]
 * @property {string} [userId]
 * @property {string} type
 * @property {number} schemaVersion
 * @property {object} payload
 * @property {{ clientId: string, clientTs: number, [key: string]: any }} meta
 * @property {number} created
 */
```

## Client Interface

### Offline Transport (Optional)

```js
/**
 * @param {{
 *   serverLastCommittedId?: number,
 *   maxBufferedSubmits?: number,
 *   onBufferedSubmit?: (entry: { id?: string, bufferedCount: number }) => void
 * }} [options]
 * @returns {{
 *   connect: () => Promise<void>,
 *   disconnect: () => Promise<void>,
 *   send: (message: object) => Promise<void>,
 *   onMessage: (handler: (message: object) => void) => () => void,
 *   setOnlineTransport: (transport: object) => Promise<void>,
 *   setOffline: () => Promise<void>,
 *   getState: () => {
 *     connected: boolean,
 *     online: boolean,
 *     waitingForOnlineConnected: boolean,
 *     bufferedSubmitCount: number
 *   }
 * }}
 */
export function createOfflineTransport(options) {}
```

### Factory

```js
/**
 * @param {Object} deps
 * @param {{
 *   send: (message: object) => Promise<void>,
 *   connect: () => Promise<void>,
 *   disconnect: () => Promise<void>,
 *   onMessage: (handler: (message: object) => void) => () => void
 * }} deps.transport
 * @param {{
 *   init: () => Promise<void>,
 *   loadCursor: () => Promise<number>,
 *   insertDraft: (item: SubmitItem) => Promise<void>,
 *   insertDrafts?: (items: SubmitItem[]) => Promise<void>,
 *   loadDraftsOrdered: () => Promise<SubmitItem[]>,
 *   applySubmitResult: (input: { result: object }) => Promise<void>,
 *   applyCommittedBatch: (input: { events: CommittedEvent[], nextCursor?: number }) => Promise<void>,
 *   loadMaterializedView?: (input: { viewName: string, partition: string }) => Promise<unknown>,
 *   loadMaterializedViews?: (input: { viewName: string, partitions: string[] }) => Promise<Record<string, unknown>>,
 *   evictMaterializedView?: (input: { viewName: string, partition: string }) => Promise<void>,
 *   invalidateMaterializedView?: (input: { viewName: string, partition: string }) => Promise<void>,
 *   flushMaterializedViews?: () => Promise<void>
 * }} deps.store
 * @param {string} deps.token
 * @param {string} deps.clientId
 * @param {string[]} deps.partitions
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => string} [deps.msgId]
 * @param {(item: SubmitItem) => void} [deps.validateLocalEvent]
 * @param {(input: { type: string, payload: any }) => void} [deps.onEvent]
 * @param {(entry: object) => void} [deps.logger]
 * @param {{
 *   enabled?: boolean,
 *   initialDelayMs?: number,
 *   maxDelayMs?: number,
 *   factor?: number,
 *   jitter?: number,
 *   maxAttempts?: number,
 *   handshakeTimeoutMs?: number
 * }} [deps.reconnect]
 * @param {{
 *   maxEvents?: number,
 *   maxBytes?: number
 * }} [deps.submitBatch]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @returns {SyncClient}
 */
export function createSyncClient(deps) {}
```

### API

```js
/**
 * @typedef {Object} SyncClient
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(partitions: string[], options?: { sinceCommittedId?: number }) => Promise<void>} setPartitions
 * @property {(items: {
 *   id?: string,
 *   partitions: string[],
 *   projectId?: string,
 *   userId?: string,
 *   type: string,
 *   schemaVersion: number,
 *   payload: object,
 *   meta?: object,
 * }[]) => Promise<string[]>} submitEvents
 * @property {(item: {
 *   id?: string,
 *   partitions: string[],
 *   projectId?: string,
 *   userId?: string,
 *   type: string,
 *   schemaVersion: number,
 *   payload: object,
 *   meta?: object,
 * }) => Promise<string>} submitEvent
 * @property {(options?: { sinceCommittedId?: number }) => Promise<void>} syncNow
 * @property {() => Promise<void>} flushDrafts
 * @property {() => {
 *   started: boolean,
 *   stopped: boolean,
 *   connected: boolean,
 *   syncInFlight: boolean,
 *   reconnectInFlight: boolean,
 *   reconnectAttempts: number,
 *   connectedServerLastCommittedId: number | null,
 *   activePartitions: string[],
 *   lastError: null | { code?: string, message?: string, details?: object }
 * }} getStatus
 */
```

Client runtime events:

- `connected`
- `sync_page`
- `committed`
- `rejected`
- `not_processed`
- `broadcast`
- `error`
- `reconnect_scheduled`

## Command Session Interface

```js
/**
 * @typedef {Object} CommandSyncSession
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(commands: object[]) => Promise<string[]>} submitCommands
 * @property {(items: object[]) => Promise<string[]>} submitEvents
 * @property {(item: object) => Promise<string>} submitEvent
 * @property {(options?: { sinceCommittedId?: number }) => Promise<void>} syncNow
 * @property {() => Promise<void>} flushDrafts
 * @property {(transport: object) => Promise<void>} setOnlineTransport
 * @property {() => object} getActor
 * @property {() => object} getStatus
 * @property {() => object | null} getLastError
 * @property {() => void} clearLastError
 */
```

## Backend Interface

### Factory

```js
/**
 * @param {Object} deps
 * @param {{
 *   verifyToken: (token: string) => Promise<{ clientId: string, claims: object }>,
 *   validateSession?: (identity: { clientId: string, claims: object }) => Promise<boolean>
 * }} deps.auth
 * @param {{ authorizePartitions: (identity: object, partitions: string[]) => Promise<boolean> }} deps.authz
 * @param {{ validate: (item: SubmitItem, ctx: object) => Promise<void> }} deps.validation
 * @param {{
 *   commitOrGetExisting: (input: {
 *     id: string,
 *     partitions: string[],
 *     projectId?: string,
 *     userId?: string,
 *     type: string,
 *     schemaVersion: number,
 *     payload: object,
 *     meta: object,
 *     now: number
 *   }) => Promise<{
 *     deduped: boolean,
 *     committedEvent: CommittedEvent
 *   }>,
 *   listCommittedSince: (input: {
 *     partitions: string[],
 *     sinceCommittedId: number,
 *     limit: number,
 *     syncToCommittedId?: number
 *   }) => Promise<{ events: CommittedEvent[], hasMore: boolean, nextSinceCommittedId: number }>,
 *   getMaxCommittedIdForPartitions: (input: { partitions: string[] }) => Promise<number>,
 *   getMaxCommittedId: () => Promise<number>
 * }} deps.store
 * @param {{ now: () => number }} deps.clock
 * @param {(entry: object) => void} [deps.logger]
 * @param {{
 *   maxInboundMessagesPerWindow?: number,
 *   rateWindowMs?: number,
 *   maxEnvelopeBytes?: number,
 *   closeOnRateLimit?: boolean,
 *   closeOnOversize?: boolean
 * }} [deps.limits]
 * @returns {SyncServer}
 */
export function createSyncServer(deps) {}
```

### API

```js
/**
 * @typedef {Object} SyncServer
 * @property {(transport: { connectionId: string, send: (message: object) => Promise<void>, close: (code?: number, reason?: string) => Promise<void> }) => ConnectionSession} attachConnection
 * @property {() => Promise<void>} shutdown
 */

/**
 * @typedef {Object} ConnectionSession
 * @property {(message: object) => Promise<void>} receive
 * @property {(reason?: string) => Promise<void>} close
 */
```

## Conformance Notes

- Client submit path may send one or more items in one `submit_events` request.
- Client runtime drains drafts in ordered batches and keeps one submit batch in flight at a time.
- `schemaVersion` is a required top-level field on every submitted and committed event.
- `submit_events_result` remains an outcome-only message; clients correlate results by `id` and do not expect echoed event fields.
- `createCommandSyncSession()` should populate/pass through `schemaVersion` when mapping commands to sync events.
- Command session callers should use `submitCommands()` for both one-command and multi-command submits.
- `submitEvent()` remains a thin wrapper over `submitEvents()`.
- Client store methods that mutate committed/draft/cursor state should use single DB transactions when available, or equivalent idempotent/monotonic SQL semantics when transactional APIs are not available.
- All behavior must match `docs/protocol/*.md`.
- Client-generated `msgId` values should be stable per outbound message for traceability.
- `meta` is open-ended JSON-safe metadata. The runtime reserves `meta.clientId` and `meta.clientTs` and may overwrite them.

## Built-in Store Adapters

Runtime exports include two persistence families:

- SQLite-style DB object (`exec`, `prepare`, optional `transaction`):
  - `createSqliteClientStore(db, options?)`
  - `createSqliteSyncStore(db, options?)`
- LibSQL client (`execute({ sql, args? })`):
  - `createLibsqlClientStore(client, options?)`
  - `createLibsqlSyncStore(client, options?)`

## Optional Materialized Views

Client store adapters may expose an optional materialized-view API:

- factory option:
  `materializedViews: [{ name, version?, initialState?, reduce, checkpoint? }]`
- runtime method: `loadMaterializedView({ viewName, partition })`
- runtime method:
  `loadMaterializedViews({ viewName, partitions }) => Record<string, unknown>`
- runtime method: `evictMaterializedView({ viewName, partition })`
- runtime method: `invalidateMaterializedView({ viewName, partition })`
- runtime method: `flushMaterializedViews()`

Checkpoint config:

```js
checkpoint: {
  mode: "immediate" | "manual" | "debounce" | "interval",
  debounceMs?: number,
  intervalMs?: number,
  maxDirtyEvents?: number,
}
```

Reducer contract:

```js
reduce({
  state,      // previous state for this (viewName, partition)
  event,      // committed event record
  partition,  // active partition being reduced
}) => nextState;
```

The reducer runs only for newly inserted committed events (deduped replays are ignored).

`reduce` is required for every materialized view definition.

Read semantics:

- `loadMaterializedView(...)` returns exact state for that partition at the local committed snapshot used by the read.
- `loadMaterializedViews(...)` does the same for multiple partitions in one call.
- `evictMaterializedView(...)` drops hot in-memory state only.
- `invalidateMaterializedView(...)` drops hot state and the persisted checkpoint for that partition.
- `flushMaterializedViews()` persists dirty checkpoints immediately.

`createReducer({ schemaHandlers })` dispatches by committed-event `type`.
Handlers receive `{ state, event, payload, partition, type }` and run in an
immer recipe context, so they may mutate `state` directly or return a
replacement object. Default reducer fallback throws for unknown event types
unless `fallback` is overridden.

Operational guidance:

- Keep materialized views to a small set (`1-3` typical, usually up to `~10` lightweight views).
- Reuse your app's event apply reducer as the single source of truth for both replay and materialized views.
- See `docs/client/materialized-views.md` for usage patterns.
