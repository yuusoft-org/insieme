// Real-life scenario: user creates drafts while offline, then reconnects.
// Client syncs first, then drains local draft queue in draft_clock order.

import Database from "better-sqlite3";
import { createWebSocketTransport } from "./common/createWebSocketTransport.js";
import { createSqliteStore } from "./common/createSqliteStore.js";
import { createCoreSyncClient } from "./common/createCoreSyncClient.js";

const db = new Database("./insieme-client.db");
const store = createSqliteStore(db);
const transport = createWebSocketTransport({
  url: "wss://api.example.com/insieme",
});

const client = createCoreSyncClient({
  transport,
  store,
  token: "<jwt-from-auth-service>",
  clientId: "device-c1",
  projectId: "workspace-1",
  onEvent: ({ type, payload }) => {
    if (type === "synced") console.log("catch-up done at", payload.cursor);
    if (type === "committed") console.log("drained draft committed", payload.id, payload.committedId);
    if (type === "rejected") console.log("drained draft rejected", payload.id, payload.reason);
  },
});

// App boot while offline:
await store.init();
await client.submitEvent({
  partition: "workspace-1",
  projectId: "workspace-1",
  type: "todo.created",
  payload: {
    id: "t1",
    title: "Buy milk",
  },
  meta: {
    clientTs: Date.now(),
  },
});
await client.submitEvent({
  partition: "workspace-1",
  projectId: "workspace-1",
  type: "todo.created",
  payload: {
    id: "t2",
    title: "Book flights",
  },
  meta: {
    clientTs: Date.now(),
  },
});

// Network comes back later:
await client.start();

// Optional explicit trigger, usually unnecessary because start() already syncs + drains:
await client.flushDrafts();
