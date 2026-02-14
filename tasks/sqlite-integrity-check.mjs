import { DatabaseSync } from "node:sqlite";

const paths = process.argv.slice(2);

if (paths.length === 0) {
  console.error(
    "Usage: npm run ops:sqlite:integrity -- <db-path> [<db-path> ...]",
  );
  process.exit(2);
}

let failed = false;

for (const dbPath of paths) {
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA integrity_check").get();
    const status = row?.integrity_check;
    if (status !== "ok") {
      failed = true;
      console.error(`${dbPath}: integrity_check failed (${String(status)})`);
    } else {
      console.log(`${dbPath}: integrity_check ok`);
    }
  } catch (error) {
    failed = true;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${dbPath}: integrity_check error (${msg})`);
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}

if (failed) {
  process.exit(1);
}
