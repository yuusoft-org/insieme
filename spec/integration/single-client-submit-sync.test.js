import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Single client connects to a server, submits events, and syncs.
 * Covers the most basic end-to-end flow of connect → submit → commit → sync.
 */
describe("integration single-client submit-sync", () => {
  it("connects, submits one event, and receives it back via syncNow", async () => {
    const { server, store: serverStore } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "tasks",
      type: "task_created",
      schemaVersion: 1,
      payload: { title: "Write integration tests" },
    });
    await tick();

    expect(store._debug.getDrafts()).toHaveLength(0);

    const clientCommitted = store._debug.getCommitted();
    expect(clientCommitted).toHaveLength(1);
    expect(clientCommitted[0]).toMatchObject({
      partition: "tasks",
      type: "task_created",
      committedId: 1,
    });

    const serverCommitted = serverStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(1);

    await client.stop();
  });

  it("submits multiple events sequentially and they commit in order", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    for (let i = 1; i <= 5; i += 1) {
      await client.submitEvent({
        partition: "items",
        type: "item_added",
        schemaVersion: 1,
        payload: { index: i },
      });
      await tick();
    }

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(5);
    expect(committed.map((e) => e.committedId)).toEqual([1, 2, 3, 4, 5]);

    await client.stop();
  });

  it("calls syncNow to catch up after restart with pre-existing events", async () => {
    const { server, store: serverStore, now } = createTestServer();

    await serverStore.commitOrGetExisting({
      id: "pre-1",
      partition: "docs",
      projectId: "proj-1",
      type: "doc_created",
      schemaVersion: 1,
      payload: { title: "Existing doc" },
      meta: { clientId: "C0", clientTs: 1000 },
      now: now(),
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.syncNow();
    await tick();

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      id: "pre-1",
      partition: "docs",
      type: "doc_created",
    });

    await client.stop();
  });

  it("client cursor advances after successful sync", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "notes",
      type: "note_added",
      schemaVersion: 1,
      payload: { text: "hello" },
    });
    await tick();

    // Cursor advances after the server responds with committed event
    await client.syncNow();
    await tick();

    const cursor = await store.loadCursor();
    expect(cursor).toBeGreaterThan(0);

    await client.stop();
  });
});
