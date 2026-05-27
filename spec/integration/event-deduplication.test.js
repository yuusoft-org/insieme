import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Event deduplication scenarios.
 * Tests that the system correctly handles duplicate submissions,
 * idempotent replays, and deduplication across reconnect.
 */
describe("integration event-deduplication", () => {
  it("replaying committed events to the client store is idempotent", async () => {
    const { server } = createTestServer();
    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "tasks",
      type: "task_done",
      schemaVersion: 1,
      payload: { id: "t1" },
    });
    await tick();

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(1);

    // Re-apply the same batch
    await store.applyCommittedBatch({
      events: committed,
      nextCursor: await store.loadCursor(),
    });

    expect(store._debug.getCommitted()).toHaveLength(1);

    await client.stop();
  });

  it("syncNow from since=0 with existing data does not duplicate", async () => {
    const { server, store: serverStore, now } = createTestServer();

    // Pre-seed server
    await serverStore.commitOrGetExisting({
      id: "seed-1",
      partition: "docs",
      projectId: "proj-1",
      type: "doc_created",
      schemaVersion: 1,
      payload: { title: "Doc 1" },
      meta: { clientId: "C0", clientTs: 999 },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "seed-2",
      partition: "docs",
      projectId: "proj-1",
      type: "doc_created",
      schemaVersion: 1,
      payload: { title: "Doc 2" },
      meta: { clientId: "C0", clientTs: 1000 },
      now: now(),
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.syncNow({ sinceCommittedId: 0 });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(2);

    // Sync again from cursor - should not duplicate
    await client.syncNow();
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(2);

    await client.stop();
  });

  it("duplicate commit on server store returns the same committed event", async () => {
    const { store: serverStore, now } = createTestServer();

    const first = await serverStore.commitOrGetExisting({
      id: "unique-1",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C1", clientTs: 1000 },
      now: now(),
    });

    const second = await serverStore.commitOrGetExisting({
      id: "unique-1",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C1", clientTs: 1000 },
      now: now(),
    });

    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committedId).toBe(
      first.committedEvent.committedId,
    );
    expect(serverStore._debug.getCommitted()).toHaveLength(1);
  });

  it("client receiving duplicate committed events via sync stays consistent", async () => {
    const { server, store: serverStore, now } = createTestServer();

    // Seed one event
    await serverStore.commitOrGetExisting({
      id: "dup-sync-1",
      partition: "data",
      projectId: "proj-1",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C0", clientTs: 1000 },
      now: now(),
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    // Sync twice from scratch
    await client.syncNow({ sinceCommittedId: 0 });
    await tick();
    await client.syncNow({ sinceCommittedId: 0 });
    await tick();

    // Should still have exactly 1 event (deduped by store)
    expect(store._debug.getCommitted()).toHaveLength(1);

    await client.stop();
  });
});
