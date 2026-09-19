# Insieme

Insieme is an offline-first sync library built around an authoritative server.
Clients create local drafts, submit them when transport is available, and
converge on a server-ordered committed event stream.

TypeScript declaration files are bundled with the package, and the published
entry points are split by environment so browser-safe imports stay distinct from
Node-only adapters.

## Install

```bash
bun add insieme
```

## Entry Points

Use the package entry point that matches your runtime.

| Import path | Use for | Includes |
| --- | --- | --- |
| `insieme` | Portable client surface. Alias of `insieme/client`. | `createSyncClient`, client transports, client stores, `createReducer` |
| `insieme/client` | Explicit client-only imports. | Same surface as `insieme` |
| `insieme/browser` | Browser-explicit imports. | Same surface as `insieme/client` |
| `insieme/node` | Node-only client + server work. | Everything in `insieme/client`, plus `createSyncServer`, WS server helpers, and Node persistence adapters |
| `insieme/server` | Backward-compatible server alias. | Same surface as `insieme/node` |

Quick rule:

- Browser app: import from `insieme` or `insieme/client`.
- Node client using SQLite: import from `insieme/node`.
- Sync server: import from `insieme/node` or `insieme/server`.

## Client Quick Start

```js
import {
  createOfflineTransport,
  createInMemoryClientStore,
  createSyncClient,
} from "insieme/client";

const clientStore = createInMemoryClientStore();
const transport = createOfflineTransport();

const client = createSyncClient({
  transport,
  store: clientStore,
  token: "jwt",
  clientId: "C1",
  projectId: "workspace-1",
});

await client.start();

await client.submitEvent({
  partition: "workspace-1",
  type: "counter.increment",
  schemaVersion: 1,
  payload: { amount: 1 },
});
```

Attach a real transport later without replacing the client instance:

```js
await transport.setOnlineTransport(realWebSocketTransport);
```

## Server Quick Start

```js
import { createInMemorySyncStore, createSyncServer } from "insieme/node";

const serverStore = createInMemorySyncStore();

const server = createSyncServer({
  auth: {
    verifyToken: async () => ({ clientId: "C1", claims: {} }),
  },
  authz: {
    authorizeProject: async () => true,
  },
  validation: {
    validate: async () => {},
  },
  store: serverStore,
  clock: { now: () => Date.now() },
});
```

## Persistence Adapters

Client-side stores:

- `createInMemoryClientStore()` from `insieme/client` for tests and dev.
- `createIndexedDbClientStore()` from `insieme/client` for browser persistence.
- `createLibsqlClientStore(client)` from `insieme/client` for `@libsql/client`.
- `createAsyncSqliteClientStore({ driver })` from `insieme/client` for injected async SQLite runtimes such as Tauri-backed adapters.
- `createSqliteClientStore(db)` from `insieme/node` for `better-sqlite3` style SQLite APIs.

Server-side sync stores:

- `createInMemorySyncStore()` from `insieme/node`.
- `createLibsqlSyncStore(client)` from `insieme/node`.
- `createSqliteSyncStore(db)` from `insieme/node`.

LibSQL example:

```js
import { createClient } from "@libsql/client";
import { createLibsqlClientStore } from "insieme/client";
import { createLibsqlSyncStore } from "insieme/node";

const clientDb = createClient({ url: "file:./insieme-client.db" });
const serverDb = createClient({ url: "file:./insieme-server.db" });

const clientStore = createLibsqlClientStore(clientDb);
const syncStore = createLibsqlSyncStore(serverDb);
```

`createCommandSyncSession` accepts `submitBatch: { maxEvents, maxBytes }` and
forwards it to `createSyncClient`. Configure this when a validated project
bootstrap exceeds the default 64 KiB batch ceiling. The default remains unchanged;
client and server transport limits must agree.

## Exact event-version inspection

All four persistent client stores accept `includeRawSchemaVersion: true` in their
options. Draft and committed readers then include `rawSchemaVersion`, preserving
the original database/driver value (including strings and bigints), alongside the
unchanged historical `schemaVersion` interpretation. Applications enforcing exact
version contracts must inspect that raw value before dispatching a versioned
payload. A stored `"2junk"` must not be treated as a valid version 2 merely because
its historical numeric interpretation is 2.

The option does not select an authoring format. `insertDraft` and `insertDrafts`
always require numeric positive safe integers for newly authored schema versions;
invalid batches fail before inserting any rows. Existing database rows remain
readable with the default reader. Acknowledgment promotion preserves their
original stored version. Applications remain responsible for supported-version
policy and validation of imported or received committed history.

No database migration, payload format, timestamp parsing, or server change is
required. `rawSchemaVersion` is read metadata, not a protocol field.

## Materialized Views

Built-in client stores support optional partition-scoped materialized views.

```js
import { createLibsqlClientStore, createReducer } from "insieme/client";

const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, payload }) => {
      state.count = (state.count ?? 0) + payload.amount;
    },
  },
});

const store = createLibsqlClientStore(db, {
  materializedViews: [
    {
      name: "event-count",
      version: "1",
      initialState: () => ({ count: 0 }),
      reduce: reducer,
    },
  ],
});

const view = await store.loadMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
});
```

Materialized views update only when a committed event is newly inserted.
Duplicate committed deliveries are ignored by the built-in stores.

Subscribe to a hot materialized view partition:

```js
const unsubscribe = await store.subscribeMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
  onChange: ({ value, lastCommittedId }) => {
    console.log(value, lastCommittedId);
  },
});
```

## Public API Highlights

- `createSyncClient`: project-scoped client runtime (`start`, `submitEvent`, `syncNow`, `flushDrafts`, `stop`, `close`).
- `createSyncServer`: authoritative server runtime (`attachConnection`, `shutdown`).
- `createOfflineTransport`: local-first transport that buffers submits until an online transport is attached.
- `createBrowserWebSocketTransport`: browser `WebSocket` transport adapter.
- Built-in client stores: stable inspection (`listDraftsOrdered`, `listCommitted`, `listCommittedAfter`, `getCursor`), view subscriptions (`subscribeMaterializedView`), and explicit `close()`.
- `attachWsConnection` / `createWsServerRuntime`: Node WebSocket bridge helpers for the server runtime.
- `createReducer`: event-type dispatcher for replay and materialized-view reducers.

## Docs

- [Docs index](./docs/README.md)
- [Package entry points](./docs/reference/package-entrypoints.md)
- [JavaScript interface reference](./docs/reference/javascript-interface.md)
- [Client storage model](./docs/client/storage.md)
- [Materialized views](./docs/client/materialized-views.md)
- [Protocol messages](./docs/protocol/messages.md)
- [Production checklist](./docs/production-checklist.md)

## Examples

Production-style examples live in [`examples/real-client-usage`](./examples/real-client-usage/README.md).

## Ops Helper

Run SQLite integrity checks:

```bash
bun run ops:sqlite:integrity -- /path/to/client.db /path/to/server.db
```

Stores expose `rawSchemaVersionAvailable` so compatibility-aware callers can
require lossless version reads before enabling a new writer. It is true only
when `includeRawSchemaVersion` was enabled.
