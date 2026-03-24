# Materialized Views

This document defines how to use the optional client-store materialized-view extension.

## What It Is

- A materialized view is partition-scoped derived state maintained by the store.
- Reads are exact for the local committed snapshot used by that read.
- Hot in-memory view state is updated on newly inserted committed events.
- Persistent checkpoints may be flushed immediately or on a policy.
- Deduped replays do not re-apply reducers.

## API

Configure views when creating a client store:
(`createSqliteClientStore(db, ...)` works the same way.)

```js
const store = createLibsqlClientStore(client, {
  materializedViews: [
    {
      name: "event-count",
      version: "1",
      checkpoint: {
        mode: "debounce",
        debounceMs: 500,
      },
      initialState: () => ({ count: 0 }),
      reduce: ({ state, event, partition }) => ({
        count:
          state.count +
          (event.type === "counter.increment" && partition === "workspace-1"
            ? event.payload.amount
            : 0),
      }),
    },
  ],
});
```

Read a partition-specific view:

```js
const view = await store.loadMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
});
```

Lifecycle helpers:

```js
await store.evictMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
});

await store.invalidateMaterializedView({
  viewName: "event-count",
  partition: "workspace-1",
});

await store.flushMaterializedViews();
```

## Expected Number Of Views

Use a small number of views.

- Typical: `1-3` views per store.
- Usually safe: up to `~10` lightweight views.
- If you need more than `10`, consolidate or split responsibility across services/processes.

Why: each committed insert applies each reducer for each partition on the event.
Work is roughly:

`O(number_of_views * matching_hot_partitions * reducer_cost)`

Keep reducers deterministic and fast.

## Checkpoint Policy

`checkpoint` controls persistence, not read freshness.

Supported modes:

- `immediate`: persist dirty checkpoints immediately.
- `manual`: keep hot state exact; persist only on `flushMaterializedViews()`.
- `debounce`: flush after no new writes for `debounceMs`.
- `interval`: flush after `intervalMs` while dirty.

Optional guard:

- `maxDirtyEvents`: force an earlier flush once enough events have accumulated.

This lets apps trade write amplification against restart replay cost without serving stale reads in the active session.

## Domain/Model Reducers

Materialized views require an explicit reducer per view definition.

The runtime exports:

- `createReducer(...)`

`createReducer` dispatches by committed-event `type`:

```js
const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, payload }) => {
      state.count = (state.count ?? 0) + payload.amount;
    },
  },
});
```

Handlers run through `immer`, so mutating `state` inside a handler is safe.
By default, `createReducer` throws for unknown event types; pass `fallback` if
you want a different policy.

## Reusing Existing Event Reducers

Plug your existing app reducer into `createReducer` and reuse the same logic
for replay and materialized views.

Recommended pattern:

```js
import { createReducer } from "insieme/client";

const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, payload }) => {
      state.count = (state.count ?? 0) + payload.amount;
    },
  },
});

const store = createLibsqlClientStore(client, {
  materializedViews: [
    {
      name: "counter",
      version: "1",
      initialState: () => ({ count: 0 }),
      reduce: reducer,
    },
  ],
});
```

This avoids duplicating event logic between:

- normal state rebuild/replay paths in your app, and
- materialized-view maintenance in the store.

## Versioning

- `version` defaults to `"1"` when omitted.
- `matchPartition` may be provided when a loaded partition should react to more than one event partition.
- Change `version` when reducer semantics or state shape changes.
- Persistent stores invalidate stale checkpoints lazily on next load and rebuild from committed events as needed.
- Reducers receive the full committed event record, so they may also inspect `meta`, `projectId`, or `userId` when needed.
