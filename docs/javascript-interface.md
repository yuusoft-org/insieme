# JavaScript Interface (Client + Backend)

This file defines the JavaScript API surface for implementation.

- Keep it small.
- Use functions/factory functions only.
- No classes.
- Wire semantics remain in `docs/protocol/*.md`.

## Interface Scope

This is the canonical JS binding interface for:

- client runtime
- backend protocol host

It is implementation-facing, while wire behavior stays normative in protocol docs.

## Shared Data Shapes

```js
/**
 * @typedef {"compatibility"|"canonical"} Profile
 *
 * compatibility: tree profile (`set`, `unset`, `tree*`)
 * canonical: event profile (`type: "event"`)
 */

/**
 * @typedef {Object} SubmitItem
 * @property {string} id
 * @property {string[]} partitions
 * @property {{ type: string, payload: object }} event
 */

/**
 * @typedef {Object} SyncRequest
 * @property {string[]} partitions
 * @property {string[]} [subscriptionPartitions]
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
 * @param {{ loadCursor: () => Promise<number>, saveCursor: (cursor: number) => Promise<void>, upsertCommitted: (event: object) => Promise<void>, markRejected: (payload: object) => Promise<void>, loadDrafts: () => Promise<SubmitItem[]> }} deps.store
 * @param {(state: object, event: object) => object} deps.reduceCommitted
 * @param {(state: object, draft: object) => object} deps.reduceDraft
 * @param {(item: SubmitItem, profile: Profile) => void} deps.validateLocalEvent
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.uuid]
 * @returns {SyncClient}
 */
export function createSyncClient(deps) {}
```

### API (Small Surface)

```js
/**
 * @typedef {Object} SyncClient
 * @property {(input: { token: string, clientId: string, supportedProfiles?: Profile[], requiredProfile?: Profile, requiredTreePolicy?: "strict" }) => Promise<void>} start
 * @property {(request: SyncRequest) => Promise<void>} sync
 * @property {(item: SubmitItem) => Promise<void>} submit
 * @property {(items: SubmitItem[]) => Promise<void>} submitMany
 * @property {(reason?: string) => Promise<void>} stop
 * @property {(event: string, handler: (payload: any) => void) => () => void} on
 * @property {() => number} getLastCommittedId
 * @property {(options?: { partitions?: string[] }) => object} getViewState
 */
```

### Client Events

`client.on(name, handler)` supports:

- `connected`
- `sync_page`
- `committed`
- `rejected`
- `broadcast`
- `version_changed`
- `error`
- `status_changed`

`committed` and `rejected` are client-runtime derived events emitted from `submit_events_result` entries.

## Client Examples

### 1) Start and Handshake

```js
const client = createSyncClient({
  transport,
  store,
  reduceCommitted,
  reduceDraft,
  validateLocalEvent,
});

await client.start({
  token,
  clientId: "C1",
  supportedProfiles: ["compatibility", "canonical"],
  requiredProfile: "compatibility",
  requiredTreePolicy: "strict",
});
```

### 2) Initial Sync

```js
await client.sync({
  partitions: ["workspace-1"],
  subscriptionPartitions: ["workspace-1", "workspace-2"],
  sinceCommittedId: client.getLastCommittedId(),
  limit: 500,
});
```

### 2a) Heartbeat

Heartbeat is automatic after `start()`. The client runtime sends `heartbeat` on an interval and processes `heartbeat_ack`.

### 3) Submit Single (Tree Profile)

```js
await client.submit({
  id: crypto.randomUUID(),
  partitions: ["workspace-1"],
  event: {
    type: "treePush",
    payload: {
      target: "explorer",
      value: { id: "A", name: "Folder A", type: "folder" },
      options: { parent: "_root", position: "first" },
    },
  },
});
```

### 4) Submit Single (Event Profile)

```js
await client.submit({
  id: crypto.randomUUID(),
  partitions: ["workspace-1"],
  event: {
    type: "event",
    payload: {
      schema: "explorer.folderCreated",
      data: { id: "A", name: "Folder A" },
    },
  },
});
```

### 5) Submit Batch (Ordered)

```js
await client.submitMany([
  {
    id: "evt-1",
    partitions: ["workspace-1"],
    event: {
      type: "treePush",
      payload: {
        target: "explorer",
        value: { id: "A" },
        options: { parent: "_root", position: "first" },
      },
    },
  },
  {
    id: "evt-2",
    partitions: ["workspace-1"],
    event: {
      type: "treeUpdate",
      payload: {
        target: "explorer",
        options: { id: "A" },
        value: { name: "Renamed" },
      },
    },
  },
]);
```

### 6) Reactive Handling (Commit/Reject/Version Change)

```js
const offCommitted = client.on("committed", (payload) => {
  console.log("committed", payload.id, payload.committed_id);
});

const offRejected = client.on("rejected", (payload) => {
  console.log("rejected", payload.id, payload.reason);
});

const offVersionChanged = client.on("version_changed", async () => {
  await client.sync({
    partitions: ["workspace-1"],
    sinceCommittedId: 0,
  });
});
```

### 7) Stop

```js
await client.stop("client_shutdown");
```

## Backend Interface

### Factory

```js
/**
 * @param {Object} deps
 * @param {{ verifyToken: (token: string) => Promise<{ clientId: string, claims: object }> }} deps.auth
 * @param {{ authorizePartitions: (identity: object, partitions: string[]) => Promise<boolean> }} deps.authz
 * @param {{ validate: (item: SubmitItem, profile: Profile, ctx: object) => Promise<void> }} deps.validation
 * @param {{ getById: (id: string) => Promise<object|null>, appendCommitted: (event: object) => Promise<void>, listCommittedSince: (input: { partitions: string[], sinceCommittedId: number, limit: number }) => Promise<{ events: object[], hasMore: boolean, nextSinceCommittedId: number, syncToCommittedId: number }>, getMaxCommittedId: () => Promise<number> }} deps.store
 * @param {{ nextCommittedId: () => Promise<number> }} deps.ids
 * @param {{ now: () => number }} deps.clock
 * @returns {SyncServer}
 */
export function createSyncServer(deps) {}
```

### API (Small Surface)

```js
/**
 * @typedef {Object} SyncServer
 * @property {(transport: { connectionId: string, send: (message: object) => Promise<void>, close: (code?: number, reason?: string) => Promise<void> }) => ConnectionSession} attachConnection
 * @property {(payload: { oldModelVersion: number, newModelVersion: number }) => Promise<void>} publishVersionChange
 * @property {() => Promise<void>} shutdown
 */
```

```js
/**
 * @typedef {Object} ConnectionSession
 * @property {(message: object) => Promise<void>} receive
 * @property {(reason?: string) => Promise<void>} close
 */
```

## Backend Examples

### 1) Attach to WebSocket

```js
const server = createSyncServer({
  auth,
  authz,
  validation,
  store,
  ids,
  clock: { now: Date.now },
});

wss.on("connection", (ws) => {
  const session = server.attachConnection({
    connectionId: crypto.randomUUID(),
    send: async (message) => ws.send(JSON.stringify(message)),
    close: async () => ws.close(),
  });

  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    await session.receive(message);
  });

  ws.on("close", async () => {
    await session.close("socket_closed");
  });
});
```

### 2) Ordered Non-Atomic Batch Is Internal to `receive`

```js
// submit_events arrives as a normal protocol message.
// session.receive(message) enforces:
// - request-level id uniqueness
// - item-by-item ordered processing
// - partial success allowed
// - committed_id preserves item order for committed entries
await session.receive(message);
```

### 2a) Heartbeat Handling

```js
await session.receive({
  type: "heartbeat",
  msg_id: "msg-hb-1",
  timestamp: Date.now(),
  protocol_version: "1.0",
  payload: {},
});
```

### 3) Global Version Change Broadcast

```js
await server.publishVersionChange({
  oldModelVersion: 3,
  newModelVersion: 4,
});
```

### 4) Graceful Shutdown

```js
await server.shutdown();
```

## Conformance Notes

- This interface intentionally keeps transport/persistence pluggable.
- All protocol behavior MUST still match `docs/protocol/*.md`.
- Puty YAML tests should target pure processing functions used by both client and backend.

## Functionality Mapping

- `connect` / `connected`: `client.start(...)` and `session.receive(connectMessage)`
- `sync` / `sync_response`: `client.sync(...)` and `session.receive(syncMessage)`
- `submit_events` (single item): `client.submit(item)` and `session.receive(submitEventsMessage)`
- `submit_events` (batch): `client.submitMany(items)` and `session.receive(submitEventsMessage)`
- `heartbeat` / `heartbeat_ack`: automatic in client runtime, handled by `session.receive(heartbeatMessage)`
- `disconnect`: `client.stop(reason)` and `session.close(reason)`
- `error`: `client.on("error", handler)` and backend `receive(...)` validation/auth boundaries
- `version_changed`: `client.on("version_changed", ...)` and `server.publishVersionChange(...)`
