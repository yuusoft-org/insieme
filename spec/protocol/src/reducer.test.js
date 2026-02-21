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

  it("applies tree insert positions and nested parent creation", () => {
    let state = {
      explorer: {
        items: {
          P: { id: "P", name: "Parent" },
        },
        tree: [{ id: "P" }],
      },
    };

    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "C1", name: "Child 1" },
            options: { parent: "P", position: "last" },
          },
        },
      },
      partition: "P1",
    });

    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "C2", name: "Child 2" },
            options: { parent: "P", position: { after: "C1" } },
          },
        },
      },
      partition: "P1",
    });

    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "C0", name: "Child 0" },
            options: { parent: "P", position: { before: "C1" } },
          },
        },
      },
      partition: "P1",
    });

    expect(state.explorer.tree[0].children.map((node) => node.id)).toEqual([
      "C0",
      "C1",
      "C2",
    ]);
  });

  it("supports delete and move no-op branches", () => {
    let state = {
      explorer: {
        items: {
          A: { id: "A" },
          B: { id: "B" },
        },
        tree: [{ id: "A", children: [{ id: "B", children: [] }] }],
      },
    };

    // Delete no-op for missing id.
    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treeDelete",
          payload: {
            target: "explorer",
            options: { id: "missing" },
          },
        },
      },
      partition: "P1",
    });
    expect(state.explorer.items.A).toEqual({ id: "A" });

    // Move no-op when item not in items.
    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treeMove",
          payload: {
            target: "explorer",
            options: { id: "missing", parent: "_root" },
          },
        },
      },
      partition: "P1",
    });
    expect(state.explorer.tree[0].id).toBe("A");

    // Remove from tree and move to root position=last.
    state = reduceEvent({
      state,
      event: {
        event: {
          type: "treeMove",
          payload: {
            target: "explorer",
            options: { id: "B", parent: "_root", position: "last" },
          },
        },
      },
      partition: "P1",
    });
    expect(state.explorer.tree.map((node) => node.id)).toEqual(["A", "B"]);
  });

  it("supports fallback branches for missing and unknown event types", () => {
    const fallbackReducer = createReducer({
      fallback: ({ state, payload }) => ({
        ...state,
        fallbackCount: ((state && state.fallbackCount) || 0) + 1,
        sawPayload: payload ?? null,
      }),
    });

    const missingType = fallbackReducer({
      state: undefined,
      event: {
        event: {
          payload: { foo: "bar" },
        },
      },
      partition: "P1",
    });
    expect(missingType).toMatchObject({
      fallbackCount: 1,
      sawPayload: { foo: "bar" },
    });

    const unknownType = fallbackReducer({
      state: missingType,
      event: {
        event: {
          type: "unknown-type",
          payload: { x: 1 },
        },
      },
      partition: "P1",
    });
    expect(unknownType.fallbackCount).toBe(2);
  });

  it("falls back for event profile when schema handler is missing", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "known.schema": ({ state }) => state,
      },
      fallback: ({ state }) => ({
        ...state,
        fallback: true,
      }),
    });

    const state = reducer({
      state: {},
      event: {
        event: {
          type: "event",
          payload: {
            schema: "unknown.schema",
            data: {},
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ fallback: true });
  });
});
