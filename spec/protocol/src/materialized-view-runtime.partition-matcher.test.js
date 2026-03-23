import { describe, expect, it } from "vitest";
import { normalizeMaterializedViewDefinitions } from "../../../src/materialized-view.js";
import { createMaterializedViewRuntime } from "../../../src/materialized-view-runtime.js";

const createDefinitions = () =>
  normalizeMaterializedViewDefinitions([
    {
      name: "counter",
      checkpoint: { mode: "manual" },
      initialState: () => ({ count: 0 }),
      matchPartition: ({ loadedPartition, eventPartition }) => {
        if (loadedPartition === "m") {
          return eventPartition === "m" || eventPartition?.startsWith("m:s:");
        }
        if (loadedPartition.startsWith("scene:")) {
          const sceneToken = loadedPartition.slice("scene:".length);
          return (
            eventPartition === `s:${sceneToken}` ||
            eventPartition === `m:s:${sceneToken}`
          );
        }
        return loadedPartition === eventPartition;
      },
      reduce: ({ state, event }) => ({
        count: state.count + (event.event.type === "increment" ? 1 : 0),
      }),
    },
  ]);

describe("src materialized-view-runtime partition matcher", () => {
  it("hydrates an exact partition view from singular committed events", async () => {
    const runtime = createMaterializedViewRuntime({
      definitions: createDefinitions(),
      getLatestCommittedId: async () => 2,
      listCommittedAfter: async ({ sinceCommittedId }) =>
        [
          { committedId: 1, partition: "s:scene01", type: "increment", payload: {}, serverTs: 10 },
          { committedId: 2, partition: "s:scene01", type: "increment", payload: {}, serverTs: 11 },
        ].filter((event) => event.committedId > sinceCommittedId),
    });

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "scene:scene01",
      }),
    ).toEqual({ count: 2 });
  });

  it("lets one logical main view consume m and m:s:* events", async () => {
    const runtime = createMaterializedViewRuntime({
      definitions: createDefinitions(),
      getLatestCommittedId: async () => 3,
      listCommittedAfter: async ({ sinceCommittedId }) =>
        [
          { committedId: 1, partition: "m", type: "increment", payload: {}, serverTs: 10 },
          { committedId: 2, partition: "m:s:scene01", type: "increment", payload: {}, serverTs: 11 },
          { committedId: 3, partition: "s:scene01", type: "increment", payload: {}, serverTs: 12 },
        ].filter((event) => event.committedId > sinceCommittedId),
    });

    expect(
      await runtime.loadMaterializedView({
        viewName: "counter",
        partition: "m",
      }),
    ).toEqual({ count: 2 });
  });
});
