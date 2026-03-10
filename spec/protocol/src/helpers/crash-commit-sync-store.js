import { createSqliteSyncStore } from "../../../../src/index.js";
import { createSqliteDb } from "./sqlite-db.js";

const [dbPath, eventId] = process.argv.slice(2);
if (!dbPath || !eventId) {
  process.stderr.write(
    "usage: node crash-commit-sync-store.js <dbPath> <eventId>\n",
  );
  process.exit(2);
}

const db = createSqliteDb(dbPath);
const store = createSqliteSyncStore(db);
await store.init();
await store.commitOrGetExisting({
  id: eventId,
  partitions: ["P1"],
  type: "x",
  payload: { n: 1 },
  meta: { clientId: "C1", clientTs: 100 },
  now: 100,
});
db.close();

// Simulate abrupt process death after durable commit but before any response path.
process.exit(23);
