# Insieme

Insieme is an offline-first sync library built around an authoritative server.
Clients create local drafts, submit them when transport is available, and
converge on a server-ordered committed event stream.

TypeScript declaration files are bundled with the package, and the published
entry points are split by environment so browser-safe imports stay distinct from
Node-only adapters.

## Install

```bash
npm install insieme
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

## Public API Highlights

- `createSyncClient`: project-scoped client runtime (`start`, `submitEvent`, `syncNow`, `flushDrafts`, `stop`).
- `createSyncServer`: authoritative server runtime (`attachConnection`, `shutdown`).
- `createOfflineTransport`: local-first transport that buffers submits until an online transport is attached.
- `createBrowserWebSocketTransport`: browser `WebSocket` transport adapter.
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
npm run ops:sqlite:integrity -- /path/to/client.db /path/to/server.db
```
