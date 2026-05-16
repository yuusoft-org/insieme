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
 * Integration: Multi-client collaboration scenarios.
 * Tests that multiple clients connected to the same server see each
 * other's events through broadcasts and sync.
 */
describe("integration multi-client collaboration", () => {
  it("two clients see each other's events after sync", async () => {
    const { server } = createTestServer();

    const alice = createTestClient({ server, clientId: "alice" });
    const bob = createTestClient({ server, clientId: "bob" });

    await alice.client.start();
    await bob.client.start();
    await tick();

    await alice.client.submitEvent({
      partition: "chat",
      type: "message_sent",
      schemaVersion: 1,
      payload: { text: "Hello from Alice" },
    });
    await tick();

    await bob.client.submitEvent({
      partition: "chat",
      type: "message_sent",
      schemaVersion: 1,
      payload: { text: "Hello from Bob" },
    });
    await tick();

    await alice.client.syncNow();
    await bob.client.syncNow();
    await tick();

    const aliceIds = readCommittedIds(alice.store);
    const bobIds = readCommittedIds(bob.store);

    expect(aliceIds).toEqual(bobIds);
    expect(aliceIds).toHaveLength(2);

    await alice.client.stop();
    await bob.client.stop();
  });

  it("three clients converge after concurrent submits and sync", async () => {
    const { server, store: serverStore } = createTestServer();

    const clients = ["C1", "C2", "C3"].map((id) =>
      createTestClient({ server, clientId: id }),
    );

    for (const { client } of clients) {
      await client.start();
    }
    await tick();

    await Promise.all(
      clients.map(({ client }) =>
        client.submitEvent({
          partition: "canvas",
          type: "stroke_added",
          schemaVersion: 1,
          payload: { color: "blue" },
        }),
      ),
    );
    await tick();

    for (const { client } of clients) {
      await client.syncNow();
    }
    await tick();

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort();

    for (const { store } of clients) {
      expect(readCommittedIds(store)).toEqual(serverIds);
    }

    for (const { client } of clients) {
      await client.stop();
    }
  });

  it("client that joins later receives all historical events", async () => {
    const { server, store: serverStore } = createTestServer();

    const early = createTestClient({ server, clientId: "early" });

    await early.client.start();
    await tick();

    for (let i = 0; i < 5; i += 1) {
      await early.client.submitEvent({
        partition: "log",
        type: "entry_added",
        schemaVersion: 1,
        payload: { seq: i },
      });
      await tick();
    }

    const serverIds = serverStore._debug
      .getCommitted()
      .map((e) => e.id)
      .sort();

    const late = createTestClient({ server, clientId: "late" });

    await late.client.start();
    await tick();

    await late.client.syncNow({ sinceCommittedId: 0 });
    await tick();

    expect(readCommittedIds(late.store)).toEqual(serverIds);

    await early.client.stop();
    await late.client.stop();
  });

  it("broadcasts from one client are visible to another via sync", async () => {
    const { server } = createTestServer();

    const alice = createTestClient({ server, clientId: "alice" });
    const bob = createTestClient({ server, clientId: "bob" });

    await alice.client.start();
    await bob.client.start();
    await tick();

    await alice.client.submitEvent({
      partition: "shared",
      type: "item_added",
      schemaVersion: 1,
      payload: { value: 42 },
    });
    await tick();

    await bob.client.syncNow();
    await tick();

    const bobCommitted = bob.store._debug.getCommitted();
    expect(bobCommitted.length).toBeGreaterThanOrEqual(1);

    await alice.client.stop();
    await bob.client.stop();
  });
});
