// Real-life scenario: app crashed after server persisted a commit,
// but before this client received submit_events_result.
// Recovery pattern: reconnect, sync from durable cursor, then flush pending drafts.

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
  partitions: ["workspace-1"],
  onEvent: ({ type, payload }) => {
    if (type === "sync_page") {
      console.log("applied sync page", {
        events: payload.events.length,
        next: payload.next_since_committed_id,
      });
    }
    if (type === "committed") {
      console.log("pending draft resolved", payload.id, payload.committed_id);
    }
  },
});

await client.start();

// Safety pattern for uncertain prior state:
// 1) sync from durable cursor (done automatically in start)
// 2) flush unresolved local drafts with same ids (dedupe-safe)
await client.flushDrafts();
