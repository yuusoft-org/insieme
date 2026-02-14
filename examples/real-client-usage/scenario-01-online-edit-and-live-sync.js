// Real-life scenario: user is online, creates a change, gets commit confirmation,
// and peers receive the broadcast.

// Assumes browser runtime (WebSocket + crypto.randomUUID).
// For desktop/node, swap transport/store implementations accordingly.

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
    if (type === "connected") console.log("connected", payload);
    if (type === "synced") console.log("synced", payload.cursor);
    if (type === "committed") console.log("local commit", payload.id, payload.committed_id);
    if (type === "broadcast") console.log("peer commit", payload.id, payload.committed_id);
    if (type === "rejected") console.warn("rejected", payload.id, payload.reason, payload.errors);
    if (type === "error") console.error("server error", payload.code, payload.message);
  },
});

await client.start();

await client.submitEvent({
  partitions: ["workspace-1"],
  event: {
    type: "event",
    payload: {
      schema: "explorer.folderCreated",
      data: { id: "folder-A", name: "Folder A" },
    },
  },
});

// In real app lifecycle, keep client running.
// await client.stop();
