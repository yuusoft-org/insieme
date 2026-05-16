import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { createInMemoryClientStore } from "../../src/in-memory-client-store.js";
import { createReducer } from "../../src/reducer.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Materialized view consistency.
 * Tests that materialized views built from the reducer remain consistent
 * as events are committed and synced.
 */
describe("integration materialized-view-consistency", () => {
  it("in-memory client store applies events through materialized views", async () => {
    const { server } = createTestServer();

    const counterView = {
      name: "counter",
      version: "1",
      initialState: { count: 0 },
      reduce: ({ state, event }) => {
        if (event?.type === "increment") {
          state.count += 1;
        }
      },
      matchesPartition: ({ loadedPartition, eventPartition }) =>
        loadedPartition === eventPartition,
    };

    const store = createInMemoryClientStore({
      materializedViews: [counterView],
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    let uuidCounter = 0;
    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-mv",
    });
    const client = createSyncClient({
      transport,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-mv-${++uuidCounter}`,
    });

    await client.start();
    await tick();

    for (let i = 0; i < 3; i += 1) {
      await client.submitEvent({
        partition: "counter",
        type: "increment",
        schemaVersion: 1,
        payload: {},
      });
      await tick();
    }

    const view = await store.loadMaterializedView({
      viewName: "counter",
      partition: "counter",
    });

    expect(view).toMatchObject({ count: 3 });

    await client.stop();
  });

  it("materialized view reflects events synced from other clients", async () => {
    const { server } = createTestServer();

    const taskView = {
      name: "task_list",
      version: "1",
      initialState: { tasks: [] },
      reduce: ({ state, event }) => {
        if (event?.type === "task_added") {
          state.tasks.push(event.payload.title);
        }
      },
      matchesPartition: ({ loadedPartition, eventPartition }) =>
        loadedPartition === eventPartition,
    };

    const aliceStore = createInMemoryClientStore({
      materializedViews: [taskView],
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    let aliceCounter = 0;
    const aliceTransport = createLoopbackTransport({
      server,
      connectionId: "conn-alice-mv",
    });
    const aliceClient = createSyncClient({
      transport: aliceTransport,
      store: aliceStore,
      token: "alice",
      clientId: "alice",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-alice-mv-${++aliceCounter}`,
    });

    const bob = createTestClient({ server, clientId: "bob" });

    await aliceClient.start();
    await bob.client.start();
    await tick();

    await bob.client.submitEvent({
      partition: "tasks",
      type: "task_added",
      schemaVersion: 1,
      payload: { title: "Design API" },
    });
    await tick();

    await bob.client.submitEvent({
      partition: "tasks",
      type: "task_added",
      schemaVersion: 1,
      payload: { title: "Write tests" },
    });
    await tick();

    await aliceClient.syncNow();
    await tick();

    const view = await aliceStore.loadMaterializedView({
      viewName: "task_list",
      partition: "tasks",
    });

    expect(view).toMatchObject({
      tasks: ["Design API", "Write tests"],
    });

    await aliceClient.stop();
    await bob.client.stop();
  });

  it("createReducer produces consistent state from committed events", async () => {
    const reducer = createReducer({
      schemaHandlers: {
        score_update: ({ state, payload }) => {
          state.total = (state.total || 0) + payload.points;
        },
      },
    });

    let state = {};
    state = reducer({
      state,
      event: { type: "score_update", payload: { points: 5 } },
      partition: "game",
    });
    state = reducer({
      state,
      event: { type: "score_update", payload: { points: 3 } },
      partition: "game",
    });
    state = reducer({
      state,
      event: { type: "score_update", payload: { points: 10 } },
      partition: "game",
    });

    expect(state).toEqual({ total: 18 });
  });

  it("materialized view with multiple partitions maintains separate state per partition", async () => {
    const { server } = createTestServer();

    const counterView = {
      name: "partition-counter",
      version: "1",
      initialState: { count: 0 },
      reduce: ({ state }) => {
        state.count += 1;
      },
      matchesPartition: ({ loadedPartition, eventPartition }) =>
        loadedPartition === eventPartition,
    };

    const store = createInMemoryClientStore({
      materializedViews: [counterView],
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    let uuidCounter = 0;
    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-pmv",
    });
    const client = createSyncClient({
      transport,
      store,
      token: "C1",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => `evt-pmv-${++uuidCounter}`,
    });

    await client.start();
    await tick();

    await client.submitEvent({ partition: "A", type: "event", schemaVersion: 1, payload: {} });
    await tick();
    await client.submitEvent({ partition: "A", type: "event", schemaVersion: 1, payload: {} });
    await tick();
    await client.submitEvent({ partition: "B", type: "event", schemaVersion: 1, payload: {} });
    await tick();

    const viewA = await store.loadMaterializedView({ viewName: "partition-counter", partition: "A" });
    const viewB = await store.loadMaterializedView({ viewName: "partition-counter", partition: "B" });

    expect(viewA).toMatchObject({ count: 2 });
    expect(viewB).toMatchObject({ count: 1 });

    await client.stop();
  });
});
