# Package Entry Points

This document describes the published npm package surface.

Implementation files live in `src/`, but package consumers should import from
the public entry points below instead of reaching into source files directly.

## Recommended Imports

| Import path | Use when | Notes |
| --- | --- | --- |
| `insieme` | You want the portable client surface and do not need Node-only adapters. | Alias of `insieme/client`. |
| `insieme/client` | You want an explicit client-only import path. | Safe default for browser and portable clients. |
| `insieme/browser` | You want a browser-explicit import path. | Same runtime surface as `insieme/client`. |
| `insieme/node` | You are running in Node and may need SQLite or server helpers. | Adds Node-only adapters and server runtime exports. |
| `insieme/server` | You want the historical server entry point. | Alias of `insieme/node`. |

## `insieme` and `insieme/client`

Portable client surface:

- `createSyncClient`
- `createOfflineTransport`
- `createBrowserWebSocketTransport`
- `createInMemoryClientStore`
- `createIndexedDbClientStore`
- `createLibsqlClientStore`
- `createReducer`

Not included:

- `createInMemorySyncStore`
- `createSqliteClientStore`
- `createSqliteSyncStore`
- `createLibsqlSyncStore`
- `createSyncServer`
- `attachWsConnection`
- `createWsServerRuntime`

Lower-level protocol/profile/canonicalization helpers are intentionally not part
of the supported package API.

## `insieme/browser`

`insieme/browser` re-exports the same portable client surface as
`insieme/client`. Use it when you want the import itself to communicate that the
module is browser-only code.

## `insieme/node` and `insieme/server`

Node-only surface. This includes everything from `insieme/client`, plus:

- `createSyncServer`
- `attachWsConnection`
- `createWsServerRuntime`
- `createInMemorySyncStore`
- `createSqliteClientStore`
- `createSqliteSyncStore`
- `createLibsqlSyncStore`

Use this entry point for:

- sync servers,
- Node clients that persist drafts and committed events in SQLite,
- apps that need both client and server helpers from one import path.

## Common Examples

Browser or portable client:

```js
import {
  createIndexedDbClientStore,
  createOfflineTransport,
  createSyncClient,
} from "insieme/client";
```

Node client with SQLite:

```js
import Database from "better-sqlite3";
import { createSqliteClientStore, createSyncClient } from "insieme/node";

const db = new Database("insieme-client.db");
const store = createSqliteClientStore(db);
```

Sync server:

```js
import { createSqliteSyncStore, createSyncServer } from "insieme/node";
```

## TypeScript

Declaration files are published for each entry point:

- `insieme` -> `types/client.d.ts`
- `insieme/client` -> `types/client.d.ts`
- `insieme/browser` -> `types/browser.d.ts`
- `insieme/node` -> `types/node.d.ts`
- `insieme/server` -> `types/server.d.ts`
