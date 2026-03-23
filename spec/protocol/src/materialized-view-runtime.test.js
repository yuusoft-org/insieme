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

const loadViews = async (runtime, viewName, partitions) =>
  Object.fromEntries(
    await Promise.all(
      partitions.map(async (partition) => [
        partition,
        await runtime.loadMaterializedView({ viewName, partition }),
      ]),
    ),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("src materialized-view-runtime", () => {
  it("drops stale checkpoints when the reducer version changes", async () => {
    const deletedCheckpoints = [];
    const runtime = createMaterializedViewRuntime({
      definitions: normalizeMaterializedViewDefinitions([
        {
          name: "counter",
          version: "2",
          checkpoint: { mode: "manual" },
          initialState: () => ({ count: 0 }),
          reduce: ({ state, event }) => ({
            count: state.count + (event.event.type === "increment" ? 1 : 0),
          }),
        },
      ]),
      getLatestCommittedId: async () => 1,
      listCommittedAfter: async () => [
        {
          committedId: 1,
          partition: "P1",
          event: { type: "increment", payload: {} },
          serverTs: 10,
        },
      ],
      loadCheckpoint: async () => ({
        viewVersion: "1",
        lastCommittedId: 7,
        value: { count: 99 },
        updatedAt: 9,
      }),
      deleteCheckpoint: async ({ viewName, partition }) => {
        deletedCheckpoints.push({ viewName, partition });
      },
    });

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });
    expect(deletedCheckpoints).toEqual([
      {
        viewName: "counter",
        partition: "P1",
      },
    ]);
  });

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
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
    });
    await runtime.onCommittedEvent({
      committedId: 2,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 11,
    });
    await runtime.onCommittedEvent({
      committedId: 3,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 12,
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

  it("supports chunked multi-partition replay via repeated loads", async () => {
    const committedEvents = [
      {
        committedId: 1,
        partition: "P1",
        event: { type: "increment", payload: {} },
        serverTs: 10,
      },
      {
        committedId: 2,
        partition: "P1",
        event: { type: "increment", payload: {} },
        serverTs: 11,
      },
      {
        committedId: 3,
        partition: "P2",
        event: { type: "increment", payload: {} },
        serverTs: 12,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      chunkSize: 1,
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committedId > sinceCommittedId)
          .slice(0, limit),
    });

    expect(await loadViews(runtime, "counter", ["P1", "P2"])).toEqual({
      P1: { count: 2 },
      P2: { count: 1 },
    });
  });

  it("flushes immediately when maxDirtyEvents is reached", async () => {
    const checkpointWrites = [];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions({
        mode: "debounce",
        debounceMs: 100,
        maxDirtyEvents: 2,
      }),
      getLatestCommittedId: async () => 2,
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
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
    });
    expect(checkpointWrites).toHaveLength(0);

    await runtime.onCommittedEvent({
      committedId: 2,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 11,
    });

    expect(checkpointWrites).toEqual([
      {
        partition: "P1",
        value: { count: 2 },
        lastCommittedId: 2,
      },
    ]);
  });

  it("flushes interval checkpoints on the configured timer", async () => {
    vi.useFakeTimers();
    const checkpointWrites = [];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions({
        mode: "interval",
        intervalMs: 20,
      }),
      getLatestCommittedId: async () => 1,
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
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(checkpointWrites).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(checkpointWrites).toEqual([
      {
        partition: "P1",
        value: { count: 1 },
        lastCommittedId: 1,
      },
    ]);
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
              committedId: 1,
              partition: "P1",
              event: { type: "increment", payload: {} },
              serverTs: 10,
            },
          ];
        }
        if (sinceCommittedId === 1) {
          return [
            {
              committedId: 2,
              partition: "P1",
              event: { type: "increment", payload: {} },
              serverTs: 11,
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
      committedId: 2,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 11,
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
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
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

  it("surfaces background checkpoint errors on the next foreground read", async () => {
    vi.useFakeTimers();
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions({
        mode: "debounce",
        debounceMs: 1,
      }),
      getLatestCommittedId: async () => 1,
      listCommittedAfter: async () => [],
      saveCheckpoint: async () => {
        throw new Error("checkpoint write failed");
      },
    });

    await runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    await runtime.onCommittedEvent({
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(
      runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).rejects.toThrow("checkpoint write failed");

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 1 });
  });

  it("rehydrates exact state after evicting a dirty hot partition", async () => {
    const committedEvents = [
      {
        committedId: 1,
        partition: "P1",
        event: { type: "increment", payload: {} },
        serverTs: 10,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      getLatestCommittedId: async () => 1,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committedId > sinceCommittedId)
          .slice(0, limit),
    });

    await runtime.loadMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    await runtime.onCommittedEvent({
      committedId: 1,
      partition: "P1",
      event: { type: "increment", payload: {} },
      serverTs: 10,
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
        committedId: 1,
        partition: "P1",
        event: { type: "increment", payload: {} },
        serverTs: 10,
      },
      {
        committedId: 2,
        partition: "P2",
        event: { type: "increment", payload: {} },
        serverTs: 11,
      },
      {
        committedId: 3,
        partition: "P1",
        event: { type: "increment", payload: {} },
        serverTs: 12,
      },
    ];
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      chunkSize: 1,
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async ({ sinceCommittedId, limit }) =>
        committedEvents
          .filter((event) => event.committedId > sinceCommittedId)
          .slice(0, limit),
    });

    const [singleP1, batched] = await Promise.all([
      runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
      loadViews(runtime, "counter", ["P1", "P2"]),
    ]);

    expect(singleP1).toEqual({ count: 2 });
    expect(batched).toEqual({
      P1: { count: 2 },
      P2: { count: 1 },
    });
  });

  it("rejects invalid single loads and ignores partitionless committed events", async () => {
    const runtime = createMaterializedViewRuntime({
      definitions: createCounterDefinitions(),
      getLatestCommittedId: async () => 0,
      listCommittedAfter: async () => [],
    });

    await expect(
      runtime.loadMaterializedView({
        viewName: "counter",
        partition: "",
      }),
    ).rejects.toThrow("loadMaterializedView requires a non-empty partition");

    await runtime.onCommittedEvent();
    await runtime.onCommittedEvent({
      committedId: 1,
      partition: "",
      event: { type: "increment", payload: {} },
      serverTs: 10,
    });

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 0 });
  });
});
