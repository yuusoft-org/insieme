# Materialized Views

This document defines how to use the optional client-store materialized-view extension.

## What It Is

- A materialized view is partition-scoped derived state maintained by the store.
- Views are updated on newly inserted committed events.
- Deduped replays do not re-apply reducers.

## API

Configure views when creating a client store:

```js
const store = createSqliteClientStore(db, {
  materializedViews: [
    {
      name: "event-count",
      version: "1",
      initialState: () => ({ count: 0 }),
      reduce: ({ state, event, partition }) => ({
        count: state.count + (event.event.type === "increment" ? 1 : 0),
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

## Expected Number Of Views

Use a small number of views.

- Typical: `1-3` views per store.
- Usually safe: up to `~10` lightweight views.
- If you need more than `10`, consolidate or split responsibility across services/processes.

Why: each committed insert applies each reducer for each partition on the event.
Work is roughly:

`O(number_of_views * event_partition_count * reducer_cost)`

Keep reducers deterministic and fast.

## Domain/Model Reducers

Materialized views require an explicit reducer per view definition.

The runtime exports:

- `createReducer(...)`

`createReducer` supports schema-driven `event` payloads:

```js
const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, data }) => {
      state.count = (state.count || 0) + data.amount;
    },
  },
});
```

Handlers run through `immer`, so mutating `state` inside a handler is safe.
By default, `createReducer` throws for unknown event types/schemas; pass
`fallback` if you want a different policy.

## Reusing Existing Event Reducers

For schema-driven `event` profile payloads, plug your existing app reducer into
`createReducer` and reuse the same logic for replay and materialized views.

Recommended pattern:

```js
import { createReducer } from "insieme";

const applyDomainCommand = ({ state, payload }) => {
  if (payload.schema === "counter.increment") {
    return { ...state, count: (state.count || 0) + payload.data.amount };
  }
  return state;
};

const reducer = createReducer({
  schemaHandlers: {
    "counter.increment": ({ state, payload }) =>
      applyDomainCommand({ state, payload }),
  },
});

const store = createSqliteClientStore(db, {
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
- Change `version` when reducer semantics or state shape changes.
- SQLite store will rebuild that view from committed events on next init.
