import { createSqliteSyncStore } from "../../../../src/index.js";
import { createSqliteDb } from "./sqlite-db.js";

const [dbPath, eventId] = process.argv.slice(2);
if (!dbPath || !eventId) {
  process.stderr.write(
    "usage: node crash-commit-sync-store.mjs <dbPath> <eventId>\n",
  );
  process.exit(2);
}

const db = createSqliteDb(dbPath);
const store = createSqliteSyncStore(db);
await store.init();
await store.commitOrGetExisting({
  id: eventId,
  clientId: "C1",
  partitions: ["P1"],
  event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
  now: 100,
});
db.close();

// Simulate abrupt process death after durable commit but before any response path.
process.exit(23);
