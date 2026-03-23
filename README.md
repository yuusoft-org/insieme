# Insieme

Insieme is an offline-first sync library built around an authoritative server.

Core runtime exports live in `src` as the single implementation path.

## Install

```bash
bun add insieme
```

## Exports

```js
import {
  createOfflineTransport,
  createSyncClient,
  createSyncServer,
  createInMemoryClientStore,
  createInMemorySyncStore,
  createSqliteClientStore,
  createSqliteSyncStore,
  createLibsqlClientStore,
  createLibsqlSyncStore,
  createReducer,
} from "insieme";
```

Server-specific WebSocket helpers are exported from `insieme/server`.

- `createSyncClient`: client runtime (`connect -> sync -> submit/flush`).
- `createSyncServer`: server session/protocol runtime.
- `createOfflineTransport`: local transport for fully offline mode, with optional later online attachment.
- `createInMemoryClientStore`: test/dev store for drafts + committed events.
- `createInMemorySyncStore`: test/dev committed-log store for server.
- `createSqliteClientStore`: SQLite adapter for the client store interface.
- `createSqliteSyncStore`: SQLite adapter for authoritative server committed log.
- `createLibsqlClientStore`: `@libsql/client` adapter for the client store interface.
- `createLibsqlSyncStore`: `@libsql/client` adapter for authoritative server committed log.
- `createReducer`: helper for dispatching committed events by `type`.

## LibSQL Usage

```js
import { createClient } from "@libsql/client";
import { createLibsqlClientStore, createLibsqlSyncStore } from "insieme";

const clientDb = createClient({ url: "file:./insieme-client.db" });
const serverDb = createClient({ url: "file:./insieme-server.db" });

const clientStore = createLibsqlClientStore(clientDb);
const syncStore = createLibsqlSyncStore(serverDb);
```

## Quick Start

```js
import {
  createInMemoryClientStore,
  createInMemorySyncStore,
  createSyncClient,
  createSyncServer,
} from "insieme";

const serverStore = createInMemorySyncStore();
const server = createSyncServer({
  auth: {
    verifyToken: async () => ({ clientId: "C1", claims: {} }),
  },
  authz: {
    authorizePartitions: async () => true,
  },
  validation: {
    validate: async () => {},
  },
  store: serverStore,
  clock: { now: () => Date.now() },
});

const clientStore = createInMemoryClientStore();
const offlineTransport = createOfflineTransport();
const client = createSyncClient({
  transport: offlineTransport,
  store: clientStore,
  token: "jwt",
  clientId: "C1",
  partitions: ["workspace-1"],
});

await client.start();
```

Seamless online upgrade later:

```js
await offlineTransport.setOnlineTransport(realWebSocketTransport);
```

## Client Store Interface

Your client store must implement:

- `init()`
- `loadCursor()`
- `insertDraft(item)`
- `loadDraftsOrdered()`
- `applySubmitResult({ result })`
- `applyCommittedBatch({ events, nextCursor? })`

See `docs/reference/javascript-interface.md` and `docs/client/storage.md`.

Optional materialized-view extension (supported by both `createInMemoryClientStore` and `createSqliteClientStore`):

```js
const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, payload }) => {
      state.count = (state.count ?? 0) + payload.amount;
    },
  },
});

const store = createSqliteClientStore(db, {
  materializedViews: [
    {
      name: "event-count",
      version: "1",
      initialState: () => ({ count: 0 }),
      reduce: reducer,
    },
  ],
});

const p1View = await store.loadMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
});
```

Materialized views are updated only when a committed event is newly inserted
(deduped duplicates are ignored), and SQLite stores persist/rebuild them by
view `name` + `version`.

Operational guidance:

- Keep view count small: usually `1-3`, generally up to `~10` lightweight views.
- Reuse the same domain reducer logic you already use for state replay to avoid duplicated logic paths.
- Materialized views require an explicit `reduce` function.
- `createReducer` dispatches by committed-event `type`.
- `createReducer` throws on unknown event types by default; pass `fallback` to customize.
- Full guide: `docs/client/materialized-views.md`.

Server runtime also supports optional inbound guardrails via `limits` (message rate and envelope size caps) for defense-in-depth reliability.
For deployments that can re-check token/session validity on every active request, provide `auth.validateSession`.

## WebSocket Server Options

When you create the `ws` server yourself, import the server entrypoint and use
`createWsServerOptions()` to get Insieme's default compression settings with
app-level overrides.

```js
import { WebSocketServer } from "ws";
import { createSyncServer, createWsServerOptions } from "insieme/server";

const syncServer = createSyncServer(/* ... */);

const wsServer = new WebSocketServer(
  createWsServerOptions({
    maxPayload: 256 * 1024,
    perMessageDeflate: {
      threshold: 512,
    },
  }),
);
```

Default `perMessageDeflate` settings:

- `threshold: 256`
- `concurrencyLimit: 10`
- `zlibDeflateOptions.level: 3`
- `zlibDeflateOptions.memLevel: 7`
- `zlibInflateOptions.chunkSize: 10 * 1024`

Set `perMessageDeflate: false` to disable compression, or pass `true` to fall
back to the raw `ws` defaults.

## Protocol Docs

- `docs/protocol/messages.md`
- `docs/protocol/connection.md`
- `docs/protocol/durability.md`
- `docs/protocol/ordering-and-idempotency.md`
- `docs/protocol/partitions.md`
- `docs/protocol/errors.md`
- `docs/production-checklist.md`

## Examples

Real usage examples are in `examples/real-client-usage/`.

## Ops Helper

Run SQLite integrity checks:

```bash
bun run ops:sqlite:integrity -- /path/to/client.db /path/to/server.db
```
