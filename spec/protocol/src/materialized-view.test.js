import { describe, expect, it } from "vitest";
import {
  normalizeMaterializedViewDefinitions,
  applyMaterializedViewReducer,
  createMaterializedViewInitialState,
  cloneMaterializedViewValue,
} from "../../../src/materialized-view.js";

describe("src materialized-view", () => {
  it("normalizes explicit reducer and version", () => {
    const [definition] = normalizeMaterializedViewDefinitions([
      {
        name: "v1",
        initialState: { count: 0 },
        reduce: ({ state, event }) => ({
          count: (state.count || 0) + (event.event.type === "increment" ? 1 : 0),
        }),
      },
    ]);

    expect(definition.version).toBe("1");
    const next = definition.reduce({
      state: { count: 0 },
      event: {
        event: { type: "increment", payload: {} },
      },
      partition: "P1",
    });
    expect(next).toEqual({ count: 1 });
  });

  it("supports initialState value/function and deep-clone semantics", () => {
    const [fromValue, fromFn] = normalizeMaterializedViewDefinitions([
      {
        name: "value",
        initialState: { nested: { n: 1 } },
        reduce: ({ state }) => state,
      },
      {
        name: "fn",
        initialState: (partition) => ({ partition }),
        reduce: ({ state }) => state,
      },
    ]);

    const first = createMaterializedViewInitialState(fromValue, "P1");
    const second = createMaterializedViewInitialState(fromValue, "P1");
    first.nested.n = 999;
    expect(second.nested.n).toBe(1);

    expect(createMaterializedViewInitialState(fromFn, "P2")).toEqual({
      partition: "P2",
    });
  });

  it("keeps previous state when reducer returns undefined", () => {
    const state = { count: 5 };
    const next = applyMaterializedViewReducer(
      {
        reduce: () => undefined,
      },
      state,
      {},
      "P1",
    );
    expect(next).toBe(state);
  });

  it("clones output values for safe external reads", () => {
    const value = { nested: { x: 1 } };
    const cloned = cloneMaterializedViewValue(value);
    cloned.nested.x = 99;
    expect(value.nested.x).toBe(1);
  });

  it("validates malformed definitions", () => {
    expect(() => normalizeMaterializedViewDefinitions({})).toThrow(
      "materializedViews must be an array",
    );
    expect(() => normalizeMaterializedViewDefinitions([null])).toThrow(
      "materializedViews[0] must be an object",
    );
    expect(() =>
      normalizeMaterializedViewDefinitions([{ name: "", reduce: () => ({}) }]),
    ).toThrow("name must be a non-empty string");
    expect(() => normalizeMaterializedViewDefinitions([{ name: "x" }])).toThrow(
      "reduce must be a function",
    );
    expect(() =>
      normalizeMaterializedViewDefinitions([{ name: "x", reduce: "nope" }]),
    ).toThrow("reduce must be a function");
    expect(() =>
      normalizeMaterializedViewDefinitions([
        { name: "x", reduce: () => ({}) },
        { name: "x", reduce: () => ({}) },
      ]),
    ).toThrow("duplicate name");
  });
});
