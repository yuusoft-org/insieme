import { describe, expect, it } from "vitest";
import { createReducer } from "../../../src/index.js";

describe("src reducer", () => {
  it("applies schemaHandlers for type=event payloads", () => {
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

  it("supports returning replacement state from schema handlers", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, data }) => ({
          ...state,
          count: (state?.count || 0) + data.amount,
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

  it("throws by default for unsupported event types", () => {
    const reducer = createReducer();

    expect(() =>
      reducer({
        state: {},
        event: {
          event: {
            type: "unknown-type",
            payload: { x: 1 },
          },
        },
        partition: "P1",
      }),
    ).toThrow("unsupported committed event type");
  });

  it("throws by default when schema handler is missing", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "known.schema": ({ state }) => state,
      },
    });

    expect(() =>
      reducer({
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
      }),
    ).toThrow("no schema handler registered");
  });

  it("falls back for missing and unknown event types", () => {
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

  it("falls back for event payload when schema handler is missing", () => {
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

  it("normalizes non-object roots before handlers execute", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, data }) => {
          state.count = (state.count || 0) + data.amount;
        },
      },
    });

    const state = reducer({
      state: null,
      event: {
        event: {
          type: "event",
          payload: {
            schema: "counter.increment",
            data: { amount: 1 },
          },
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ count: 1 });
  });
});
