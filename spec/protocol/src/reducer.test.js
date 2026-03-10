import { describe, expect, it } from "vitest";
import { createReducer } from "../../../src/index.js";

describe("src reducer", () => {
  it("applies handlers for top-level committed-event type/payload", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, payload }) => {
          state.count = (state.count || 0) + payload.amount;
        },
      },
    });

    const state = reducer({
      state: { count: 1 },
      event: {
        type: "counter.increment",
        payload: {
          amount: 2,
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ count: 3 });
  });

  it("supports returning replacement state from handlers", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, payload }) => ({
          ...state,
          count: (state?.count || 0) + payload.amount,
        }),
      },
    });

    const state = reducer({
      state: { count: 1 },
      event: {
        type: "counter.increment",
        payload: {
          amount: 2,
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
          type: "unknown-type",
          payload: { x: 1 },
        },
        partition: "P1",
      }),
    ).toThrow("no handler registered");
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
        payload: { foo: "bar" },
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
        type: "unknown-type",
        payload: { x: 1 },
      },
      partition: "P1",
    });

    expect(unknownType.fallbackCount).toBe(2);
  });

  it("falls back when handler is missing", () => {
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
        type: "unknown.schema",
        payload: {},
      },
      partition: "P1",
    });

    expect(state).toEqual({ fallback: true });
  });

  it("normalizes non-object roots before handlers execute", () => {
    const reducer = createReducer({
      schemaHandlers: {
        "counter.increment": ({ state, payload }) => {
          state.count = (state.count || 0) + payload.amount;
        },
      },
    });

    const state = reducer({
      state: null,
      event: {
        type: "counter.increment",
        payload: {
          amount: 1,
        },
      },
      partition: "P1",
    });

    expect(state).toEqual({ count: 1 });
  });
});
