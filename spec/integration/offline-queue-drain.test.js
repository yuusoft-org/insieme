import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createInMemoryClientStore } from "../../src/in-memory-client-store.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Offline draft queue and drain after reconnect.
 * Tests that events created while disconnected are persisted as drafts
 * and flushed to the server when the client reconnects.
 */
describe("integration offline-queue-drain", () => {
  it("drafts queued while stopped are drained after restart", async () => {
    const { server } = createTestServer();

    const sharedStore = createInMemoryClientStore();
    const clientId = "C1";

    let node = createTestClient({ server, clientId, store: undefined });
    // Use sharedStore directly via manual client construction approach:
    // Since createTestClient creates its own store, we'll use the shared store pattern.

    // Actually, the existing createTestClient creates its own store.
    // For shared store across restarts, we create the client manually:
    await node.client.start();
    await tick();
    await node.client.stop();

    // Insert drafts while offline into the node's own store
    await node.store.insertDraft({
      id: "offline-1",
      partition: "tasks",
      type: "task_created",
      schemaVersion: 1,
      payload: { title: "Task 1" },
      meta: { clientId: "C1", clientTs: 2001 },
      createdAt: 2001,
    });
    await node.store.insertDraft({
      id: "offline-2",
      partition: "tasks",
      type: "task_created",
      schemaVersion: 1,
      payload: { title: "Task 2" },
      meta: { clientId: "C1", clientTs: 2002 },
      createdAt: 2002,
    });
    await node.store.insertDraft({
      id: "offline-3",
      partition: "tasks",
      type: "task_created",
      schemaVersion: 1,
      payload: { title: "Task 3" },
      meta: { clientId: "C1", clientTs: 2003 },
      createdAt: 2003,
    });

    expect(node.store._debug.getDrafts()).toHaveLength(3);

    // Reconnect with same store (need to create new client with same store)
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const transport2 = createLoopbackTransport({
      server,
      connectionId: `conn-${clientId}-2`,
    });
    let uuid2Counter = 0;
    const client2 = createSyncClient({
      transport: transport2,
      store: node.store,
      token: clientId,
      clientId,
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-offline-${++uuid2Counter}`,
    });

    await client2.start();
    await client2.flushDrafts();
    await tick();

    expect(node.store._debug.getDrafts()).toHaveLength(0);
    expect(node.store._debug.getCommitted().map((e) => e.id)).toEqual([
      "offline-1",
      "offline-2",
      "offline-3",
    ]);

    await client2.stop();
  });

  it("partially flushed queue resumes on next flush", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({
      server,
      clientId: "C1",
      reconnect: {},
    });

    await client.start();
    await tick();

    for (let i = 1; i <= 5; i += 1) {
      await store.insertDraft({
        id: `partial-${i}`,
        partition: "data",
        type: "entry",
        schemaVersion: 1,
        payload: { n: i },
        meta: { clientId: "C1", clientTs: 2000 + i },
        createdAt: 2000 + i,
      });
    }

    await client.flushDrafts();
    await tick();
    await client.flushDrafts();
    await tick();
    await client.flushDrafts();
    await tick();

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(store._debug.getCommitted()).toHaveLength(5);

    await client.stop();
  });

  it("offline drafts survive a full client stop/start cycle", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();
    await client.stop();

    await store.insertDraft({
      id: "survive-1",
      partition: "notes",
      type: "note_created",
      schemaVersion: 1,
      payload: { body: "offline note" },
      meta: { clientId: "C1", clientTs: 2100 },
      createdAt: 2100,
    });

    // Create new client with same store
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const transport2 = createLoopbackTransport({
      server,
      connectionId: "conn-C1-restart",
    });
    let uuidCounter = 0;
    const client2 = createSyncClient({
      transport: transport2,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-survive-${++uuidCounter}`,
    });

    await client2.start();
    await client2.flushDrafts();
    await tick();

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(store._debug.getCommitted().map((e) => e.id)).toEqual(["survive-1"]);

    await client2.stop();
  });
});
