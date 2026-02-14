import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createSqliteClientStore,
  createSqliteSyncStore,
  createSyncClient,
  createSyncServer,
} from "../../../src/index.js";
import { createSqliteDb } from "./helpers/sqlite-db.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createNowFactory = (start = 1000) => {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
};

const createUuidFactory = (prefix) => {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}-${i}`;
  };
};

const tempDirs = [];

const createPaths = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "insieme-sqlite-e2e-"));
  tempDirs.push(dir);
  return {
    serverDbPath: path.join(dir, "server.db"),
    clientDbPath: path.join(dir, "client.db"),
  };
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const createLoopbackTransport = ({ server, connectionId }) => {
  /** @type {null|((message: object) => void)} */
  let onMessage = null;
  /** @type {null|{ receive: (message: object) => Promise<void>, close: (reason?: string) => Promise<void> }} */
  let session = null;
  let connected = false;

  const serverTransport = {
    connectionId,
    send: async (message) => {
      if (onMessage) onMessage(message);
    },
    close: async () => {
      connected = false;
      session = null;
    },
  };

  return {
    connect: async () => {
      if (connected) return;
      session = server.attachConnection(serverTransport);
      connected = true;
    },
    disconnect: async () => {
      if (!connected || !session) return;
      await session.close("client_disconnect");
      connected = false;
      session = null;
    },
    send: async (message) => {
      if (!connected || !session) throw new Error("disconnected");
      await session.receive(message);
    },
    onMessage: (handler) => {
      onMessage = handler;
      return () => {
        if (onMessage === handler) onMessage = null;
      };
    },
  };
};

describe("src sqlite end-to-end reliability", () => {
  it("recovers through server/client restart and drains offline draft deterministically", async () => {
    const { serverDbPath, clientDbPath } = createPaths();

    let serverDb = createSqliteDb(serverDbPath);
    let serverStore = createSqliteSyncStore(serverDb);
    await serverStore.init();
    let server = createSyncServer({
      auth: { verifyToken: async () => ({ clientId: "C1", claims: {} }) },
      authz: { authorizePartitions: async () => true },
      validation: { validate: async () => {} },
      store: serverStore,
      clock: { now: createNowFactory(1000) },
    });

    let clientDb = createSqliteDb(clientDbPath);
    let clientStore = createSqliteClientStore(clientDb);
    let client = createSyncClient({
      transport: createLoopbackTransport({
        server,
        connectionId: "conn-C1",
      }),
      store: clientStore,
      token: "C1",
      clientId: "C1",
      partitions: ["P1"],
      now: createNowFactory(2000),
      uuid: createUuidFactory("online"),
    });

    await client.start();
    await tick();
    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
    });
    await client.flushDrafts();
    await client.syncNow();
    await tick();
    await client.stop();

    clientDb.close();
    serverDb.close();

    clientDb = createSqliteDb(clientDbPath);
    clientStore = createSqliteClientStore(clientDb);
    await clientStore.init();
    await clientStore.insertDraft({
      id: "offline-3",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      createdAt: 3000,
    });
    clientDb.close();

    serverDb = createSqliteDb(serverDbPath);
    serverStore = createSqliteSyncStore(serverDb);
    await serverStore.init();
    server = createSyncServer({
      auth: { verifyToken: async () => ({ clientId: "C1", claims: {} }) },
      authz: { authorizePartitions: async () => true },
      validation: { validate: async () => {} },
      store: serverStore,
      clock: { now: createNowFactory(4000) },
    });

    clientDb = createSqliteDb(clientDbPath);
    clientStore = createSqliteClientStore(clientDb);
    client = createSyncClient({
      transport: createLoopbackTransport({
        server,
        connectionId: "conn-C1",
      }),
      store: clientStore,
      token: "C1",
      clientId: "C1",
      partitions: ["P1"],
      now: createNowFactory(5000),
      uuid: createUuidFactory("unused"),
    });

    await client.start();
    await client.flushDrafts();
    await client.syncNow();
    await tick();

    const clientDrafts = clientDb._raw
      .prepare("SELECT COUNT(*) AS count FROM local_drafts")
      .get();
    const clientCommitted = clientDb._raw
      .prepare("SELECT id FROM committed_events ORDER BY committed_id ASC")
      .all()
      .map((row) => row.id);
    expect(clientDrafts.count).toBe(0);
    expect(clientCommitted).toEqual(["online-1", "online-2", "offline-3"]);

    const serverCommitted = serverDb._raw
      .prepare("SELECT id FROM committed_events ORDER BY committed_id ASC")
      .all()
      .map((row) => row.id);
    expect(serverCommitted).toEqual(["online-1", "online-2", "offline-3"]);

    await client.stop();
    clientDb.close();
    serverDb.close();
  });
});
