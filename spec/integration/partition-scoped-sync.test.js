import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { tick } from "../harness/event-helpers.js";

const readCommittedIds = (store) =>
  store._debug
    .getCommitted()
    .map((e) => e.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Integration: Partition-scoped synchronization.
 * Tests that events in different partitions are correctly handled and that
 * sync returns all partitions' events for a project.
 */
describe("integration partition-scoped-sync", () => {
  it("events from different partitions are all committed and synced", async () => {
    const { server, store: serverStore } = createTestServer();

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "tasks",
      type: "task_created",
      schemaVersion: 1,
      payload: { title: "Task 1" },
    });
    await tick();

    await client.submitEvent({
      partition: "notes",
      type: "note_added",
      schemaVersion: 1,
      payload: { body: "A note" },
    });
    await tick();

    await client.submitEvent({
      partition: "settings",
      type: "config_changed",
      schemaVersion: 1,
      payload: { theme: "dark" },
    });
    await tick();

    const serverCommitted = serverStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(3);
    expect(serverCommitted.map((e) => e.partition).sort()).toEqual([
      "notes",
      "settings",
      "tasks",
    ]);

    const clientCommitted = store._debug.getCommitted();
    expect(clientCommitted).toHaveLength(3);

    await client.stop();
  });

  it("sync from since=0 returns all partitions' events", async () => {
    const { server, store: serverStore, now } = createTestServer();

    await serverStore.commitOrGetExisting({
      id: "p1-e1",
      partition: "users",
      projectId: "proj-1",
      type: "user_added",
      schemaVersion: 1,
      payload: { name: "Alice" },
      meta: { clientId: "C0", clientTs: 1000 },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "p2-e1",
      partition: "messages",
      projectId: "proj-1",
      type: "msg_sent",
      schemaVersion: 1,
      payload: { text: "Hello" },
      meta: { clientId: "C0", clientTs: 1001 },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "p1-e2",
      partition: "users",
      projectId: "proj-1",
      type: "user_updated",
      schemaVersion: 1,
      payload: { name: "Bob" },
      meta: { clientId: "C0", clientTs: 1002 },
      now: now(),
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.syncNow({ sinceCommittedId: 0 });
    await tick();

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(3);

    const partitions = committed.map((e) => e.partition).sort();
    expect(partitions).toEqual(["messages", "users", "users"]);

    await client.stop();
  });

  it("two clients using different partitions converge via sync", async () => {
    const { server } = createTestServer();

    const client1 = createTestClient({ server, clientId: "C1" });
    const client2 = createTestClient({ server, clientId: "C2" });

    await client1.client.start();
    await client2.client.start();
    await tick();

    await client1.client.submitEvent({
      partition: "team-a",
      type: "action",
      schemaVersion: 1,
      payload: { from: "C1" },
    });
    await tick();

    await client2.client.submitEvent({
      partition: "team-b",
      type: "action",
      schemaVersion: 1,
      payload: { from: "C2" },
    });
    await tick();

    await client1.client.syncNow();
    await client2.client.syncNow();
    await tick();

    expect(readCommittedIds(client1.store)).toEqual(
      readCommittedIds(client2.store),
    );
    expect(readCommittedIds(client1.store)).toHaveLength(2);

    await client1.client.stop();
    await client2.client.stop();
  });

  it("large number of partitions does not affect correctness", async () => {
    const { server } = createTestServer();

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    const partitionCount = 20;
    for (let i = 0; i < partitionCount; i += 1) {
      await client.submitEvent({
        partition: `partition-${i}`,
        type: "event",
        schemaVersion: 1,
        payload: { partitionIndex: i },
      });
      await tick();
    }

    const committed = store._debug.getCommitted();
    expect(committed).toHaveLength(partitionCount);

    const uniquePartitions = new Set(committed.map((e) => e.partition));
    expect(uniquePartitions.size).toBe(partitionCount);

    await client.stop();
  });
});
