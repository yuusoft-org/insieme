import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createSqliteSyncStore } from "../../../src/index.js";
import { createSqliteDb } from "./helpers/sqlite-db.js";

const tempDirs = [];

const createDbPath = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-crash-proc-"));
  tempDirs.push(dir);
  return path.join(dir, "server.db");
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("src sqlite process crash safety", () => {
  it("keeps committed row durable across process crash and dedupes retry", async () => {
    const dbPath = createDbPath();
    const scriptPath = fileURLToPath(
      new URL("./helpers/crash-commit-sync-store.mjs", import.meta.url),
    );

    const proc = spawnSync(
      process.execPath,
      [scriptPath, dbPath, "evt-proc-1"],
      {
        encoding: "utf8",
      },
    );
    expect(proc.status).toBe(23);

    const db = createSqliteDb(dbPath);
    const store = createSqliteSyncStore(db);
    await store.init();

    const retry = await store.commitOrGetExisting({
      id: "evt-proc-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      now: 200,
    });
    expect(retry).toMatchObject({
      deduped: true,
      committedEvent: {
        id: "evt-proc-1",
        committed_id: 1,
      },
    });

    const row = db._raw
      .prepare("SELECT COUNT(*) AS count FROM committed_events WHERE id = ?")
      .get("evt-proc-1");
    expect(row.count).toBe(1);
    db.close();
  });
});
