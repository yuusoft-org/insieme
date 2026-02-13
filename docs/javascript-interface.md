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
 * @property {{ type: string, payload: object }} event
 */

/**
 * @typedef {Object} SyncRequest
 * @property {string[]} partitions
 * @property {number} sinceCommittedId
 * @property {number} [limit]
 */
```

## Client Interface

### Factory

```js
/**
 * @param {Object} deps
 * @param {{ send: (message: object) => Promise<void>, connect: () => Promise<void>, disconnect: () => Promise<void> }} deps.transport
 * @param {{
 *   loadCursor: () => Promise<number>,
 *   saveCursor: (cursor: number) => Promise<void>,
 *   insertDraft: (item: SubmitItem) => Promise<void>,
 *   loadDraftsOrdered: () => Promise<SubmitItem[]>,
 *   applyCommitted: (event: object) => Promise<void>,
 *   removeDraftById: (id: string) => Promise<void>
 * }} deps.store
 * @param {(item: SubmitItem) => void} deps.validateLocalEvent
 * @returns {SyncClient}
 */
export function createSyncClient(deps) {}
```

### API

```js
/**
 * @typedef {Object} SyncClient
 * @property {(input: { token: string, clientId: string }) => Promise<void>} start
 * @property {(request: SyncRequest) => Promise<void>} sync
 * @property {(item: SubmitItem) => Promise<void>} submit
 * @property {() => Promise<void>} stop
 * @property {(event: string, handler: (payload: any) => void) => () => void} on
 * @property {() => number} getLastCommittedId
 */
```

Client runtime events:

- `connected`
- `sync_page`
- `committed`
- `rejected`
- `broadcast`
- `error`

## Backend Interface

### Factory

```js
/**
 * @param {Object} deps
 * @param {{ verifyToken: (token: string) => Promise<{ clientId: string, claims: object }> }} deps.auth
 * @param {{ authorizePartitions: (identity: object, partitions: string[]) => Promise<boolean> }} deps.authz
 * @param {{ validate: (item: SubmitItem, ctx: object) => Promise<void> }} deps.validation
 * @param {{
 *   getById: (id: string) => Promise<object|null>,
 *   appendCommitted: (event: object) => Promise<void>,
 *   listCommittedSince: (input: { partitions: string[], sinceCommittedId: number, limit: number }) => Promise<{ events: object[], hasMore: boolean, nextSinceCommittedId: number }>,
 *   getMaxCommittedId: () => Promise<number>
 * }} deps.store
 * @param {{ nextCommittedId: () => Promise<number> }} deps.ids
 * @param {{ now: () => number }} deps.clock
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

- Client submit path is single-item in core mode.
- Server still receives `submit_events` wire message shape with one `events[0]` item.
- All behavior must match `docs/protocol/*.md`.
