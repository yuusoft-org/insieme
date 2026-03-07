import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMaterializedViewDefinitions } from "../../../src/materialized-view.js";
import { createMaterializedViewRuntime } from "../../../src/materialized-view-runtime.js";

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const createCounterDefinitions = (checkpoint = { mode: "manual" }) =>
  normalizeMaterializedViewDefinitions([
    {
      name: "counter",
      checkpoint,
      initialState: () => ({ count: 0 }),
      reduce: ({ state, event }) => ({
        count: state.count + (event.event.type === "increment" ? 1 : 0),
      }),
    },
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe("src materialized-view-runtime", () => {
  it("collapses debounce checkpoint churn to the latest state", async () => {
    vi.useFakeTimers();
    const checkpointWrites = [];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions({
        mode: "debounce",
        debounceMs: 20,
      }),
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async () => [],
      saveCheckpoint: async ({ partition, value, lastCommittedId }) => {
        checkpointWrites.push({
          partition,
          value,
          lastCommittedId,
        });
      },
    });

    await runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    await runtime.onCommittedEvent({
      committed_id: 1,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 10,
    });
    await runtime.onCommittedEvent({
      committed_id: 2,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 11,
    });
    await runtime.onCommittedEvent({
      committed_id: 3,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 12,
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(checkpointWrites).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(checkpointWrites).toEqual([
      {
        partition: "P1",
        value: { count: 3 },
        lastCommittedId: 3,
      },
    ]);
  });

  it("supports chunked multi-partition replay for batch reads", async () => {
    const committedEvents = [
      {
        committed_id: 1,
        partitions: ["P1"],
        event: { type: "increment", payload: {} },
        status_updated_at: 10,
      },
      {
        committed_id: 2,
        partitions: ["P1", "P2"],
        event: { type: "increment", payload: {} },
        status_updated_at: 11,
      },
      {
        committed_id: 3,
        partitions: ["P2"],
        event: { type: "increment", payload: {} },
        status_updated_at: 12,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      chunkSize: 1,
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committed_id > sinceCommittedId)
          .slice(0, limit),
    });

    expect(
      await runtime.loadMaterializedViews({
        viewName: "counter",
        partitions: ["P1", "P2"],
      }),
    ).toEqual({
      P1: { count: 2 },
      P2: { count: 2 },
    });
  });

  it("keeps read results exact when newer commits arrive during hydration", async () => {
    let latestCommittedId = 1;
    const hydrateGate = createDeferred();
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      getLatestCommittedId: async () => latestCommittedId,
      listCommittedAfter: async ({ sinceCommittedId }) => {
        if (sinceCommittedId === 0) {
          await hydrateGate.promise;
          return [
            {
              committed_id: 1,
              partitions: ["P1"],
              event: { type: "increment", payload: {} },
              status_updated_at: 10,
            },
          ];
        }
        return [];
      },
    });

    const firstRead = runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    await Promise.resolve();
    latestCommittedId = 2;
    const commitDuringRead = runtime.onCommittedEvent({
      committed_id: 2,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 11,
    });

    hydrateGate.resolve();

    expect(await firstRead).toEqual({ count: 1 });
    await commitDuringRead;
    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });
  });

  it("does not rewrite checkpoints after invalidate races with a debounced flush", async () => {
    const flushStarted = createDeferred();
    const allowFlushToFinish = createDeferred();
    const checkpoints = new Map();
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions({
        mode: "debounce",
        debounceMs: 1,
      }),
      getLatestCommittedId: async () => 1,
      listCommittedAfter: async () => [],
      saveCheckpoint: async ({
        viewName,
        partition,
        value,
        lastCommittedId,
      }) => {
        flushStarted.resolve();
        await allowFlushToFinish.promise;
        checkpoints.set(`${viewName}:${partition}`, {
          value,
          lastCommittedId,
        });
      },
      deleteCheckpoint: async ({ viewName, partition }) => {
        checkpoints.delete(`${viewName}:${partition}`);
      },
    });

    await runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    await runtime.onCommittedEvent({
      committed_id: 1,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushStarted.promise;

    const invalidatePromise = runtime.invalidateMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    allowFlushToFinish.resolve();
    await invalidatePromise;

    expect(checkpoints.has("counter:P1")).toBe(false);
  });

  it("rehydrates exact state after evicting a dirty hot partition", async () => {
    const committedEvents = [
      {
        committed_id: 1,
        partitions: ["P1"],
        event: { type: "increment", payload: {} },
        status_updated_at: 10,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      getLatestCommittedId: async () => 1,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committed_id > sinceCommittedId)
          .slice(0, limit),
    });

    await runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    await runtime.onCommittedEvent({
      committed_id: 1,
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      status_updated_at: 10,
    });

    await runtime.evictMaterializedView({
      viewName: "counter",
      partition: "P1",
    });

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });
  });

  it("keeps batch reads consistent while partitions are replayed in chunks", async () => {
    const committedEvents = [
      {
        committed_id: 1,
        partitions: ["P1"],
        event: { type: "increment", payload: {} },
        status_updated_at: 10,
      },
      {
        committed_id: 2,
        partitions: ["P2"],
        event: { type: "increment", payload: {} },
        status_updated_at: 11,
      },
      {
        committed_id: 3,
        partitions: ["P1", "P2"],
        event: { type: "increment", payload: {} },
        status_updated_at: 12,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      chunkSize: 1,
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committed_id > sinceCommittedId)
          .slice(0, limit),
    });

    const [singleP1, batched] = await Promise.all([
      runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
      runtime.loadMaterializedViews({
        viewName: "counter",
        partitions: ["P1", "P2"],
      }),
    ]);

    expect(singleP1).toEqual({ count: 2 });
    expect(batched).toEqual({
      P1: { count: 2 },
      P2: { count: 2 },
    });
  });
});
