import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSqliteClientStore,
  createSqliteSyncStore,
  createSyncClient,
  createSyncServer,
} from "../../src/index.js";
import { createLoopbackTransport } from "../harness/create-loopback-transport.js";
import { createSqliteDb, hasNodeSqlite } from "../protocol/src/helpers/sqlite-db.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const tempDirs = [];

const createTempPaths = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-production-storage-e2e-"));
  tempDirs.push(dir);
  return {
    serverDbPath: path.join(dir, "server.sqlite"),
    clientADbPath: path.join(dir, "client-a.sqlite"),
    clientBDbPath: path.join(dir, "client-b.sqlite"),
  };
};

const createNow = (start) => {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
};

const createProductionServer = ({ dbPath, nowStart, logs }) => {
  const db = createSqliteDb(dbPath);
  const store = createSqliteSyncStore(db);
  const server = createSyncServer({
    auth: {
      verifyToken: async (token) => ({ clientId: token, claims: {} }),
    },
    authz: { authorizeProject: async () => true },
    validation: { validate: async () => {} },
    store,
    clock: { now: createNow(nowStart) },
    logger: (entry) => logs.push(entry),
  });
  return { db, store, server };
};

const createProductionClient = ({
  server,
  store,
  clientId,
  nowStart,
  connectionId = `conn-${clientId}`,
}) => {
  const transport = createLoopbackTransport({ server, connectionId });
  const client = createSyncClient({
    transport,
    store,
    token: clientId,
    clientId,
    projectId: "proj-1",
    now: createNow(nowStart),
    uuid: () => `${clientId}-unused-random-id`,
    reconnect: { enabled: false },
  });
  return { client, transport };
};

const listServerRows = (db) =>
  db._raw
    .prepare(
      "SELECT committed_id, id FROM committed_events ORDER BY committed_id ASC",
    )
    .all();

const listClientIds = async (store) =>
  (await store._debug.getCommitted()).map((event) => event.id);

const describeSqlite = hasNodeSqlite ? describe : describe.skip;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describeSqlite("production SQLite storage e2e convergence", () => {
  it("converges across clients after SQLite server restart and dedupes a retried commit", async () => {
    const { serverDbPath, clientADbPath, clientBDbPath } = createTempPaths();
    const serverLogs = [];
    let clientA;
    let clientB;
    let serverDb;

    try {
      let productionServer = createProductionServer({
        dbPath: serverDbPath,
        nowStart: 10_000,
        logs: serverLogs,
      });
      serverDb = productionServer.db;

      const clientAStore = createSqliteClientStore(createSqliteDb(clientADbPath));
      const clientBStore = createSqliteClientStore(createSqliteDb(clientBDbPath));

      ({ client: clientA } = createProductionClient({
        server: productionServer.server,
        store: clientAStore,
        clientId: "client-a",
        nowStart: 20_000,
        connectionId: "conn-client-a-before-restart",
      }));
      await clientA.start();
      await tick();

      await clientA.submitEvents([
        {
          id: "evt-a-1",
          partition: "docs",
          type: "doc.created",
          schemaVersion: 1,
          payload: { title: "first" },
        },
        {
          id: "evt-a-2",
          partition: "docs",
          type: "doc.updated",
          schemaVersion: 1,
          payload: { title: "second" },
        },
      ]);
      await clientA.flushDrafts();
      await clientA.syncNow();
      await tick();

      ({ client: clientB } = createProductionClient({
        server: productionServer.server,
        store: clientBStore,
        clientId: "client-b",
        nowStart: 30_000,
        connectionId: "conn-client-b-before-restart",
      }));
      await clientB.start();
      await clientB.syncNow();
      await tick();

      expect(await listClientIds(clientBStore)).toEqual(["evt-a-1", "evt-a-2"]);
      expect(listServerRows(serverDb).map((row) => row.id)).toEqual([
        "evt-a-1",
        "evt-a-2",
      ]);

      await clientA.stop();
      await clientB.stop();
      serverDb.close();

      productionServer = createProductionServer({
        dbPath: serverDbPath,
        nowStart: 40_000,
        logs: serverLogs,
      });
      serverDb = productionServer.db;

      ({ client: clientA } = createProductionClient({
        server: productionServer.server,
        store: clientAStore,
        clientId: "client-a",
        nowStart: 50_000,
        connectionId: "conn-client-a-after-restart",
      }));
      await clientA.start();
      await tick();

      await clientA.submitEvent({
        id: "evt-a-1",
        partition: "docs",
        type: "doc.created",
        schemaVersion: 1,
        payload: { title: "first" },
      });
      await clientA.flushDrafts();
      await clientA.syncNow();
      await tick();

      const rowsAfterRetry = listServerRows(serverDb);
      expect(rowsAfterRetry.map((row) => row.id)).toEqual(["evt-a-1", "evt-a-2"]);
      expect(new Set(rowsAfterRetry.map((row) => row.id)).size).toBe(2);
      expect(
        serverLogs.some(
          (entry) =>
            entry.event === "submit_committed" &&
            entry.id === "evt-a-1" &&
            entry.deduped === true,
        ),
      ).toBe(true);
      expect(await clientAStore._debug.getDrafts()).toEqual([]);
      expect(await listClientIds(clientAStore)).toEqual(["evt-a-1", "evt-a-2"]);

      await clientA.stop();

      ({ client: clientB } = createProductionClient({
        server: productionServer.server,
        store: clientBStore,
        clientId: "client-b",
        nowStart: 60_000,
        connectionId: "conn-client-b-after-restart",
      }));
      await clientB.start();
      await clientB.syncNow();
      await tick();

      expect(await clientBStore._debug.getDrafts()).toEqual([]);
      expect(await listClientIds(clientBStore)).toEqual(["evt-a-1", "evt-a-2"]);
      expect(await clientBStore.loadCursor()).toBe(2);
      expect(listServerRows(serverDb)).toHaveLength(2);
    } finally {
      await clientA?.close?.().catch(() => {});
      await clientB?.close?.().catch(() => {});
      try {
        serverDb?.close?.();
      } catch {
        // best effort cleanup when a test assertion fails after an explicit close
      }
    }
  });
});
