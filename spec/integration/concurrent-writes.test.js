import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createRng, tick } from "../harness/event-helpers.js";

const readCommittedIds = (store) =>
  store._debug
    .getCommitted()
    .map((e) => e.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Integration: Concurrent writes from multiple clients.
 * Verifies that when multiple clients submit concurrently, all events
 * are committed in a total order and eventually converge on every client.
 */
describe("integration concurrent-writes", () => {
  it("parallel submits from two clients all commit and converge", async () => {
    const { server, store: serverStore } = createTestServer();

    const alice = createTestClient({ server, clientId: "alice" });
    const bob = createTestClient({ server, clientId: "bob" });

    await alice.client.start();
    await bob.client.start();
    await tick();

    await Promise.all([
      alice.client.submitEvent({
        partition: "board",
        type: "card_added",
        schemaVersion: 1,
        payload: { title: "Card A" },
      }),
      bob.client.submitEvent({
        partition: "board",
        type: "card_added",
        schemaVersion: 1,
        payload: { title: "Card B" },
      }),
    ]);
    await tick();

    const serverCommitted = serverStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(2);
    expect(
      serverCommitted.map((e) => e.committedId).sort((a, b) => a - b),
    ).toEqual([1, 2]);

    await alice.client.syncNow();
    await bob.client.syncNow();
    await tick();

    expect(readCommittedIds(alice.store)).toEqual(readCommittedIds(bob.store));
    expect(readCommittedIds(alice.store)).toHaveLength(2);

    await alice.client.stop();
    await bob.client.stop();
  });

  it("rapid sequential submits from one client commit in order", async () => {
    const { server, store: serverStore } = createTestServer();

    const { client } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    for (let i = 0; i < 10; i += 1) {
      await client.submitEvent({
        partition: "log",
        type: "entry",
        schemaVersion: 1,
        payload: { seq: i },
      });
      await tick();
    }

    const serverCommitted = serverStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(10);

    const committedIds = serverCommitted.map((e) => e.committedId);
    for (let i = 1; i < committedIds.length; i += 1) {
      expect(committedIds[i]).toBeGreaterThan(committedIds[i - 1]);
    }

    await client.stop();
  });

  it("chaos simulation: 3 clients, random submits/syncs converge", async () => {
    const seed = 42;
    const rand = createRng(seed);
    const { server, store: serverStore } = createTestServer();

    /** @type {{ client: any, store: any }[]} */
    const nodes = [];
    for (let i = 0; i < 3; i += 1) {
      const node = createTestClient({ server, clientId: `C${i + 1}` });
      nodes.push(node);
      await node.client.start();
    }
    await tick();

    for (let step = 0; step < 60; step += 1) {
      const index = Math.floor(rand() * nodes.length);
      const node = nodes[index];
      const action = rand();

      if (action < 0.6) {
        await node.client.submitEvent({
          partition: "chaos",
          type: "event",
          schemaVersion: 1,
          payload: { seed, step, index },
        });
      } else if (action < 0.8) {
        await node.client.syncNow();
      } else {
        await node.client.flushDrafts();
      }
    }

    for (const node of nodes) {
      await node.client.syncNow();
      await node.client.flushDrafts();
    }
    await tick();

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const node of nodes) {
      expect(readCommittedIds(node.store)).toEqual(serverIds);
      expect(node.store._debug.getDrafts()).toHaveLength(0);
    }

    for (const node of nodes) {
      await node.client.stop();
    }
  });
});
