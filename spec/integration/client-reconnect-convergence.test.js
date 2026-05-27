import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createInMemoryClientStore } from "../../src/in-memory-client-store.js";
import { createRng, tick } from "../harness/event-helpers.js";

const readCommittedIds = (store) =>
  store._debug
    .getCommitted()
    .map((e) => e.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Integration: Client reconnect convergence.
 * Tests that after disconnections and reconnects, clients eventually
 * converge to the same state as the server.
 */
describe("integration client-reconnect-convergence", () => {
  it("client stops and reconnects, then syncs missed events", async () => {
    const { server, store: serverStore } = createTestServer();

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "data",
      type: "create",
      schemaVersion: 1,
      payload: { n: 1 },
    });
    await tick();
    await client.stop();

    // Another client adds events while first is offline
    const other = createTestClient({ server, clientId: "C2" });

    await other.client.start();
    await tick();

    await other.client.submitEvent({
      partition: "data",
      type: "create",
      schemaVersion: 1,
      payload: { n: 2 },
    });
    await tick();
    await other.client.stop();

    // Reconnect with same store
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    let uuidCounter = 0;
    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-C1-r2",
    });
    const client2 = createSyncClient({
      transport,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-recon-${++uuidCounter}`,
    });

    await client2.start();
    await tick();

    await client2.syncNow();
    await tick();

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort();
    expect(readCommittedIds(store)).toEqual(serverIds);
    expect(readCommittedIds(store)).toHaveLength(2);

    await client2.stop();
  });

  it("multiple reconnect cycles preserve data integrity", async () => {
    const { server, store: serverStore } = createTestServer();

    const sharedStore = createInMemoryClientStore();
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    for (let cycle = 0; cycle < 5; cycle += 1) {
      let uuidCounter = 0;
      const transport = createLoopbackTransport({
        server,
        connectionId: `conn-cycle-${cycle}`,
      });
      const client = createSyncClient({
        transport,
        store: sharedStore,
        token: "C1",
        clientId: "C1",
        projectId: "proj-1",
        now: () => Date.now(),
        uuid: () => `evt-cycle-${cycle}-${++uuidCounter}`,
      });

      await client.start();
      await tick();

      await client.submitEvent({
        partition: "data",
        type: "tick",
        schemaVersion: 1,
        payload: { cycle },
      });
      await tick();

      await client.stop();
    }

    // Final sync
    let finalCounter = 0;
    const finalTransport = createLoopbackTransport({
      server,
      connectionId: "conn-final",
    });
    const finalClient = createSyncClient({
      transport: finalTransport,
      store: sharedStore,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-final-${++finalCounter}`,
    });

    await finalClient.start();
    await finalClient.syncNow();
    await tick();

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort();
    expect(readCommittedIds(sharedStore)).toEqual(serverIds);
    expect(serverIds).toHaveLength(5);

    await finalClient.stop();
  });

  it("three clients with random disconnects all converge", async () => {
    const seed = 99;
    const rand = createRng(seed);
    const { server, store: serverStore } = createTestServer();

    const stores = [
      createInMemoryClientStore(),
      createInMemoryClientStore(),
      createInMemoryClientStore(),
    ];

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const mkClient = (index, store) => {
      let c = 0;
      const id = `C${index + 1}`;
      const transport = createLoopbackTransport({
        server,
        connectionId: `conn-rc-${id}`,
      });
      return createSyncClient({
        transport,
        store,
        token: id,
        clientId: id,
        projectId: "proj-1",
        now: () => Date.now(),
        uuid: () => `evt-rc-${id}-${++c}`,
      });
    };

    /** @type {{ client: any, store: any }[]} */
    const clients = stores.map((store, i) => ({
      client: mkClient(i, store),
      store,
    }));

    for (const { client } of clients) {
      await client.start();
    }
    await tick();

    for (let step = 0; step < 80; step += 1) {
      const index = Math.floor(rand() * clients.length);
      const node = clients[index];
      const action = rand();

      if (action < 0.4) {
        await node.client.submitEvent({
          partition: "shared",
          type: "event",
          schemaVersion: 1,
          payload: { seed, step, index },
        });
      } else if (action < 0.65) {
        await node.client.syncNow();
      } else if (action < 0.8) {
        await node.client.flushDrafts();
      } else {
        await node.client.stop();
        const restarted = mkClient(index, node.store);
        clients[index] = { client: restarted, store: node.store };
        await restarted.start();
      }
    }

    // Final convergence
    for (const node of clients) {
      await node.client.syncNow();
      await node.client.flushDrafts();
    }
    await tick();

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const store of stores) {
      expect(readCommittedIds(store)).toEqual(serverIds);
      expect(store._debug.getDrafts()).toHaveLength(0);
    }

    for (const { client } of clients) {
      await client.stop();
    }
  });
});
