import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createInMemoryClientStore } from "../../src/in-memory-client-store.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Cursor-based incremental sync.
 * Tests that the cursor mechanism correctly tracks progress and that
 * incremental syncs only fetch new events since the last cursor position.
 */
describe("integration cursor-incremental-sync", () => {
  it("cursor advances after each batch of events", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    const cursor0 = await store.loadCursor();

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
    });
    await tick();
    await client.syncNow();
    await tick();

    const cursor1 = await store.loadCursor();
    expect(cursor1).toBeGreaterThan(cursor0);

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { n: 2 },
    });
    await tick();
    await client.syncNow();
    await tick();

    const cursor2 = await store.loadCursor();
    expect(cursor2).toBeGreaterThan(cursor1);

    await client.stop();
  });

  it("syncNow since cursor returns only new events", async () => {
    const { server, store: serverStore, now } = createTestServer();

    // Seed server with initial events
    await serverStore.commitOrGetExisting({
      id: "init-1",
      partition: "data",
      projectId: "proj-1",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C0", clientTs: 1000 },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "init-2",
      partition: "data",
      projectId: "proj-1",
      type: "item",
      schemaVersion: 1,
      payload: { n: 2 },
      meta: { clientId: "C0", clientTs: 1001 },
      now: now(),
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    // Initial sync gets all events
    await client.syncNow({ sinceCommittedId: 0 });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(2);
    const cursorAfterInit = await store.loadCursor();
    expect(cursorAfterInit).toBeGreaterThan(0);

    // Add more events to server
    await serverStore.commitOrGetExisting({
      id: "new-1",
      partition: "data",
      projectId: "proj-1",
      type: "item",
      schemaVersion: 1,
      payload: { n: 3 },
      meta: { clientId: "C2", clientTs: 2000 },
      now: now(),
    });

    // Incremental sync from cursor
    await client.syncNow();
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(3);
    expect(store._debug.getCommitted().map((e) => e.id).sort()).toEqual([
      "init-1",
      "init-2",
      "new-1",
    ]);

    await client.stop();
  });

  it("cursor remains valid across client restart", async () => {
    const { server } = createTestServer();

    const sharedStore = createInMemoryClientStore();
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    // Session 1
    let c = 0;
    const transport1 = createLoopbackTransport({
      server,
      connectionId: "conn-cur-1",
    });
    const client1 = createSyncClient({
      transport: transport1,
      store: sharedStore,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-cur-${++c}`,
    });

    await client1.start();
    await tick();

    await client1.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
    });
    await tick();
    await client1.syncNow();
    await tick();

    const cursorBeforeStop = await sharedStore.loadCursor();
    expect(cursorBeforeStop).toBeGreaterThan(0);

    await client1.stop();

    // Session 2: cursor should be preserved
    const cursorAfterRestart = await sharedStore.loadCursor();
    expect(cursorAfterRestart).toBe(cursorBeforeStop);

    const transport2 = createLoopbackTransport({
      server,
      connectionId: "conn-cur-2",
    });
    const client2 = createSyncClient({
      transport: transport2,
      store: sharedStore,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-cur-2-${++c}`,
    });

    await client2.start();
    await tick();

    await client2.syncNow();
    await tick();

    // No new events, cursor should not change
    expect(await sharedStore.loadCursor()).toBe(cursorAfterRestart);

    await client2.stop();
  });

  it("multiple syncNow calls without new events are idempotent", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
    });
    await tick();

    const committed1 = store._debug.getCommitted();
    expect(committed1).toHaveLength(1);

    // Multiple syncs
    for (let i = 0; i < 5; i += 1) {
      await client.syncNow();
      await tick();
    }

    expect(store._debug.getCommitted()).toHaveLength(1);

    await client.stop();
  });

  it("cursor 0 with syncNow fetches full history", async () => {
    const { server, store: serverStore, now } = createTestServer();

    // Pre-seed 10 events
    for (let i = 1; i <= 10; i += 1) {
      await serverStore.commitOrGetExisting({
        id: `hist-${i}`,
        partition: "data",
        projectId: "proj-1",
        type: "item",
        schemaVersion: 1,
        payload: { n: i },
        meta: { clientId: "C0", clientTs: 1000 + i },
        now: now(),
      });
    }

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.syncNow({ sinceCommittedId: 0 });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(10);
    const cursor = await store.loadCursor();
    expect(cursor).toBe(10);

    await client.stop();
  });
});
