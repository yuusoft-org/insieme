# Insieme

Insieme is an offline-first sync library built around an authoritative server.

Core runtime exports live in `src` as the single implementation path.

## Install

```bash
npm install insieme
```

## Exports

```js
import {
  createSyncClient,
  createSyncServer,
  createInMemoryClientStore,
  createInMemorySyncStore,
  createSqliteClientStore,
  createSqliteSyncStore,
} from "insieme";
```

- `createSyncClient`: client runtime (`connect -> sync -> submit/flush`).
- `createSyncServer`: server session/protocol runtime.
- `createInMemoryClientStore`: test/dev store for drafts + committed events.
- `createInMemorySyncStore`: test/dev committed-log store for server.
- `createSqliteClientStore`: SQLite adapter for the client store interface.
- `createSqliteSyncStore`: SQLite adapter for authoritative server committed log.

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
const client = createSyncClient({
  transport: {
    connect: async () => {},
    disconnect: async () => {},
    send: async (_message) => {},
    onMessage: (_handler) => () => {},
  },
  store: clientStore,
  token: "jwt",
  clientId: "C1",
  partitions: ["workspace-1"],
});

await client.start();
```

## Client Store Interface

Your client store must implement:

- `init()`
- `loadCursor()`
- `insertDraft(item)`
- `loadDraftsOrdered()`
- `applySubmitResult({ result, fallbackClientId })`
- `applyCommittedBatch({ events, nextCursor? })`

See `docs/reference/javascript-interface.md` and `docs/client/storage.md`.

Server runtime also supports optional inbound guardrails via `limits` (message rate and envelope size caps) for defense-in-depth reliability.

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
