import { describe, expect, it } from "vitest";
import {
  createInMemoryClientStore,
  createInMemorySyncStore,
  createSyncClient,
  createSyncServer,
} from "../../../src-next/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createNowFactory = (start = 2000) => {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
};

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

describe("src-next trace logging", () => {
  it("logs id and committed_id on server commit path", async () => {
    const logs = [];
    const serverStore = createInMemorySyncStore();
    const server = createSyncServer({
      auth: { verifyToken: async () => ({ clientId: "C1", claims: {} }) },
      authz: { authorizePartitions: async () => true },
      validation: { validate: async () => {} },
      store: serverStore,
      clock: { now: createNowFactory() },
      logger: (entry) => logs.push(entry),
    });

    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-C1",
    });
    const client = createSyncClient({
      transport,
      store: createInMemoryClientStore(),
      token: "C1",
      clientId: "C1",
      partitions: ["P1"],
      now: createNowFactory(),
      uuid: () => "evt-log-1",
    });

    await client.start();
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await tick();

    const submitCommitted = logs.find(
      (entry) => entry.event === "submit_committed",
    );
    expect(submitCommitted).toBeTruthy();
    expect(submitCommitted.id).toBe("evt-log-1");
    expect(submitCommitted.committed_id).toBe(1);

    const syncPage = logs.find((entry) => entry.event === "sync_page_sent");
    expect(syncPage).toBeTruthy();
    expect(syncPage).toMatchObject({
      event_count: expect.any(Number),
      next_since_committed_id: expect.any(Number),
    });
  });

  it("logs draft id and commit id on client side", async () => {
    const clientLogs = [];
    const server = createSyncServer({
      auth: { verifyToken: async () => ({ clientId: "C1", claims: {} }) },
      authz: { authorizePartitions: async () => true },
      validation: { validate: async () => {} },
      store: createInMemorySyncStore(),
      clock: { now: createNowFactory() },
    });

    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-C1",
    });
    const client = createSyncClient({
      transport,
      store: createInMemoryClientStore(),
      token: "C1",
      clientId: "C1",
      partitions: ["P1"],
      now: createNowFactory(),
      uuid: () => "evt-client-log-1",
      logger: (entry) => clientLogs.push(entry),
    });

    await client.start();
    await tick();

    await client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await tick();

    const inserted = clientLogs.find(
      (entry) => entry.event === "draft_inserted",
    );
    const committed = clientLogs.find(
      (entry) => entry.event === "submit_committed",
    );

    expect(inserted).toBeTruthy();
    expect(inserted.id).toBe("evt-client-log-1");
    expect(committed).toBeTruthy();
    expect(committed.id).toBe("evt-client-log-1");
    expect(committed.committed_id).toBe(1);
  });
});
