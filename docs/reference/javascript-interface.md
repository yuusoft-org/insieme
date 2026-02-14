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
 * @property {string} clientId
 * @property {string[]} partitions
 * @property {{ type: string, payload: object }} event
 * @property {number} createdAt
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
 *   loadDraftsOrdered: () => Promise<SubmitItem[]>,
 *   applySubmitResult: (input: { result: object, fallbackClientId: string }) => Promise<void>,
 *   applyCommittedBatch: (input: { events: object[], nextCursor?: number }) => Promise<void>
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
 * @property {(item: { partitions: string[], event: { type: string, payload: object } }) => Promise<string>} submitEvent
 * @property {(options?: { sinceCommittedId?: number }) => Promise<void>} syncNow
 * @property {() => Promise<void>} flushDrafts
 */
```

Client runtime events:

- `connected`
- `sync_page`
- `committed`
- `rejected`
- `broadcast`
- `error`
- `reconnect_scheduled`

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
 *   commitOrGetExisting: (input: { id: string, clientId: string, partitions: string[], event: object, now: number }) => Promise<{
 *     deduped: boolean,
 *     committedEvent: {
 *       id: string,
 *       client_id: string,
 *       partitions: string[],
 *       committed_id: number,
 *       event: object,
 *       status_updated_at: number
 *     }
 *   }>,
 *   listCommittedSince: (input: { partitions: string[], sinceCommittedId: number, limit: number, syncToCommittedId?: number }) => Promise<{ events: object[], hasMore: boolean, nextSinceCommittedId: number }>,
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

- Client submit path is single-item in core mode.
- Server still receives `submit_events` wire message shape with one `events[0]` item.
- Client store methods that mutate committed/draft/cursor state should be implemented as single DB transactions.
- All behavior must match `docs/protocol/*.md`.
- Client-generated `msg_id` values should be stable per outbound message for traceability.
