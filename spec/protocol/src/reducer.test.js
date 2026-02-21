import { describe, expect, it } from "vitest";
import { createReducer, reduceEvent } from "../../../src/index.js";

describe("src reducer", () => {
  it("applies set and unset operations", () => {
    let state = {};

    state = reduceEvent({
      state,
      event: {
        event: {
          type: "set",
          payload: {
            target: "profile",
            value: { name: "Ada" },
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({
      profile: { name: "Ada" },
    });

    state = reduceEvent({
      state,
      event: {
        event: {
          type: "unset",
          payload: {
            target: "profile",
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({});
  });

  it("keeps orphan on treePush to missing parent", () => {
    const state = reduceEvent({
      state: {},
      event: {
        event: {
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "A", name: "Orphan", type: "file" },
            options: { parent: "missing-parent" },
          },
        },
      },
      partition: "P1",
    });

    expect(state.explorer.items.A).toEqual({
      id: "A",
      name: "Orphan",
      type: "file",
    });
    expect(state.explorer.tree).toEqual([]);
  });

  it("updates missing item on treeUpdate as upsert", () => {
    const state = reduceEvent({
      state: {},
      event: {
        event: {
          type: "treeUpdate",
          payload: {
            target: "explorer",
            value: { name: "Inserted via update", type: "folder" },
            options: { id: "N1", replace: false },
          },
        },
      },
      partition: "P1",
    });

    expect(state.explorer.items.N1).toEqual({
      name: "Inserted via update",
      type: "folder",
    });
  });

  it("drops moved node from tree when moving into own descendant", () => {
    const initial = {
      explorer: {
        items: {
          A: { id: "A" },
          B: { id: "B" },
        },
        tree: [
          {
            id: "A",
            children: [{ id: "B", children: [] }],
          },
        ],
      },
    };

    const state = reduceEvent({
      state: initial,
      event: {
        event: {
          type: "treeMove",
          payload: {
            target: "explorer",
            options: {
              id: "A",
              parent: "B",
              position: "first",
            },
          },
        },
      },
      partition: "P1",
    });

    expect(state.explorer.tree).toEqual([]);
    expect(state.explorer.items.A).toEqual({ id: "A" });
    expect(state.explorer.items.B).toEqual({ id: "B" });
  });

  it("supports custom handlers through createReducer", () => {
    const reducer = createReducer({
      handlers: {
        event: ({ state, payload }) => ({
          ...state,
          count: (state?.count || 0) + payload.data.amount,
        }),
      },
    });

    const state = reducer({
      state: { count: 1 },
      event: {
        event: {
          type: "event",
          payload: {
            schema: "counter.increment",
            data: { amount: 2 },
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ count: 3 });
  });

  it("supports schemaHandlers for type=event payloads", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, data }) => {
          state.count = (state.count || 0) + data.amount;
        },
      },
    });

    const state = reducer({
      state: { count: 1 },
      event: {
        event: {
          type: "event",
          payload: {
            schema: "counter.increment",
            data: { amount: 2 },
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ count: 3 });
  });
});
