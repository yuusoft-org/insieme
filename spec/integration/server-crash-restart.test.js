import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createInMemoryClientStore } from "../../src/in-memory-client-store.js";
import { createInMemorySyncStore } from "../../src/in-memory-sync-store.js";
import { tick } from "../harness/event-helpers.js";

const readCommittedIds = (store) =>
  store._debug
    .getCommitted()
    .map((e) => e.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Integration: Server crash / restart resilience.
 * Tests that clients recover when the server crashes and restarts,
 * using the same persistent store.
 */
describe("integration server-crash-restart", () => {
  it("client recovers committed events after server restart", async () => {
    const persistentStore = createInMemorySyncStore();
    let { server } = createTestServer();
    // Override with our persistent store by creating server manually
    const { createSyncServer } = await import("../../src/sync-server.js");
    let nowVal = 1000;
    const now = () => { nowVal += 1; return nowVal; };

    server = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: persistentStore,
      clock: { now },
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "data",
      type: "value_set",
      schemaVersion: 1,
      payload: { key: "x", value: 10 },
    });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(1);
    await client.stop();

    // Server restarts with the same persistent store
    nowVal = 5000;
    const server2 = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: persistentStore,
      clock: { now },
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const transport = createLoopbackTransport({ server: server2, connectionId: "conn-C1-r" });
    let uuidCounter = 0;
    const client2 = createSyncClient({
      transport,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-restart-${++uuidCounter}`,
    });

    await client2.start();
    await client2.syncNow();
    await tick();

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ committedId: 1 });

    await client2.stop();
  });

  it("server deduplicates events on crash-after-commit replay", async () => {
    const persistentStore = createInMemorySyncStore();
    let crashOnce = true;

    const crashingStore = {
      ...persistentStore,
      commitOrGetExisting: async (input) => {
        const result = await persistentStore.commitOrGetExisting(input);
        if (crashOnce) {
          crashOnce = false;
          throw new Error("crash-after-commit");
        }
        return result;
      },
    };

    const { createSyncServer } = await import("../../src/sync-server.js");
    let nowVal = 1000;
    const now = () => { nowVal += 1; return nowVal; };

    const server = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: crashingStore,
      clock: { now },
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    try {
      await client.submitEvent({
        partition: "data",
        type: "item_added",
        schemaVersion: 1,
        payload: { n: 1 },
      });
      await tick();
    } catch {
      // transport disconnected expected
    }
    await client.stop();

    // Restart server with persistent store
    nowVal = 3000;
    const server2 = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: persistentStore,
      clock: { now },
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const transport = createLoopbackTransport({ server: server2, connectionId: "conn-C1-d" });
    let uuidCounter = 0;
    const client2 = createSyncClient({
      transport,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-dedup-${++uuidCounter}`,
    });

    await client2.start();
    await client2.syncNow();
    await tick();

    const serverCommitted = persistentStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(1);

    await client2.stop();
  });

  it("multiple clients converge after server restart", async () => {
    const persistentStore = createInMemorySyncStore();
    const { createSyncServer } = await import("../../src/sync-server.js");

    let nowVal = 1000;
    const now = () => { nowVal += 1; return nowVal; };

    let server = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: persistentStore,
      clock: { now },
    });

    const sharedStore1 = createInMemoryClientStore();
    const sharedStore2 = createInMemoryClientStore();

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const mkClient = (id, store, srv) => {
      const transport = createLoopbackTransport({ server: srv, connectionId: `conn-${id}` });
      let c = 0;
      return createSyncClient({
        transport,
        store,
        token: id,
        clientId: id,
        projectId: "proj-1",
        now: () => Date.now(),
        uuid: () => `evt-${id}-${++c}`,
      });
    };

    let c1 = mkClient("C1", sharedStore1, server);
    let c2 = mkClient("C2", sharedStore2, server);

    await c1.start();
    await c2.start();
    await tick();

    await c1.submitEvent({ partition: "shared", type: "update", schemaVersion: 1, payload: { from: "C1" } });
    await tick();
    await c2.submitEvent({ partition: "shared", type: "update", schemaVersion: 1, payload: { from: "C2" } });
    await tick();

    await c1.stop();
    await c2.stop();

    // Restart
    nowVal = 5000;
    server = createSyncServer({
      auth: { verifyToken: async (token) => ({ clientId: token, claims: {} }) },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store: persistentStore,
      clock: { now },
    });

    c1 = mkClient("C1", sharedStore1, server);
    c2 = mkClient("C2", sharedStore2, server);

    await c1.start();
    await c2.start();
    await tick();

    await c1.syncNow();
    await c2.syncNow();
    await tick();

    expect(readCommittedIds(sharedStore1)).toEqual(readCommittedIds(sharedStore2));
    expect(readCommittedIds(sharedStore1)).toHaveLength(2);

    await c1.stop();
    await c2.stop();
  });
});
