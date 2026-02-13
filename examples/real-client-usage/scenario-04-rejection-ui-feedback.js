// Real-life scenario: server rejects a draft and UI shows field-level feedback.

import Database from "better-sqlite3";
import { createWebSocketTransport } from "./common/createWebSocketTransport.js";
import { createSqliteStore } from "./common/createSqliteStore.js";
import { createCoreSyncClient } from "./common/createCoreSyncClient.js";

function showFormErrors(errors = []) {
  for (const err of errors) {
    console.warn(`Field ${err.field}: ${err.message}`);
  }
}

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
    if (type === "rejected") {
      if (payload.reason === "validation_failed") showFormErrors(payload.errors);
      if (payload.reason === "forbidden") console.warn("No permission for target partition/resource");
    }
  },
});

await client.start();

await client.submitEvent({
  partitions: ["workspace-1"],
  event: {
    type: "event",
    payload: {
      schema: "todo.created",
      data: { id: "", title: "" }, // intentionally invalid for server-side example
    },
  },
});
