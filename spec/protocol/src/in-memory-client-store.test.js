import { describe, expect, it } from "vitest";
import { createInMemoryClientStore } from "../../../src/index.js";

const makeDraft = (overrides = {}) => ({
  id: "evt-1",
  partitions: ["P1"],
  type: "x",
  payload: { n: 1 },
  meta: { clientId: "C1", clientTs: 100 },
  createdAt: 100,
  ...overrides,
});

const makeCommitted = (overrides = {}) => ({
  id: "evt-1",
  partitions: ["P1"],
  committedId: 1,
  type: "x",
  payload: { n: 1 },
  meta: { clientId: "C1", clientTs: 10 },
  created: 10,
  ...overrides,
});

const counterView = {
  name: "counter",
  checkpoint: { mode: "manual" },
  initialState: () => ({ count: 0 }),
  reduce: ({ state, event }) => ({
    count: state.count + (event.type === "increment" ? 1 : 0),
  }),
};

describe("src createInMemoryClientStore", () => {
  it("orders drafts by draftClock then id", async () => {
    const store = createInMemoryClientStore();
    await store.init();

    await store.insertDraft(makeDraft({ id: "b", payload: { n: 1 }, createdAt: 100 }));
    await store.insertDraft(makeDraft({ id: "a", payload: { n: 2 }, createdAt: 101 }));

    const drafts = await store.loadDraftsOrdered();
    expect(drafts.map((draft) => draft.id)).toEqual(["b", "a"]);
  });

  it("applies committed submit result atomically (commit insert + draft cleanup)", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft(makeDraft({ id: "evt-1" }));

    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committedId: 10,
        created: 111,
      },
    });

    const drafts = store._debug.getDrafts();
    const committed = store._debug.getCommitted();

    expect(drafts).toHaveLength(0);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      id: "evt-1",
      committedId: 10,
      meta: { clientId: "C1", clientTs: 100 },
      created: 111,
    });
  });

  it("applies rejected submit result by removing draft only", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft(makeDraft({ id: "evt-r" }));

    await store.applySubmitResult({
      result: {
        id: "evt-r",
        status: "rejected",
        reason: "validation_failed",
        created: 111,
      },
    });

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(store._debug.getCommitted()).toHaveLength(0);
  });

  it("applies committed batches idempotently and updates cursor", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft(makeDraft({ id: "evt-1" }));

    const events = [
      makeCommitted({ id: "evt-1", committedId: 1, payload: { n: 1 }, created: 10 }),
      makeCommitted({
        id: "evt-2",
        committedId: 2,
        payload: { n: 2 },
        meta: { clientId: "C2", clientTs: 11 },
        created: 11,
      }),
    ];

    await store.applyCommittedBatch({ events, nextCursor: 2 });
    await store.applyCommittedBatch({ events, nextCursor: 2 });

    const drafts = store._debug.getDrafts();
    const committed = store._debug.getCommitted();

    expect(drafts).toHaveLength(0);
    expect(committed).toHaveLength(2);
    expect(committed.map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
    expect(await store.loadCursor()).toBe(2);
  });

  it("keeps cursor monotonic when an older nextCursor is received", async () => {
    const store = createInMemoryClientStore();

    await store.applyCommittedBatch({ events: [], nextCursor: 10 });
    await store.applyCommittedBatch({ events: [], nextCursor: 4 });

    expect(await store.loadCursor()).toBe(10);
  });

  it("throws on conflicting duplicate committed ids", async () => {
    const store = createInMemoryClientStore();

    await store.applyCommittedBatch({
      events: [makeCommitted({ id: "evt-1", committedId: 1, payload: { n: 1 } })],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [makeCommitted({ id: "evt-1", committedId: 2, payload: { n: 1 }, created: 11 })],
        nextCursor: 2,
      }),
    ).rejects.toThrow("committed event invariant violation");
  });

  it("maintains materialized views per partition across commit paths", async () => {
    const store = createInMemoryClientStore({
      materializedViews: [counterView],
    });

    await store.insertDraft(
      makeDraft({
        id: "evt-1",
        type: "increment",
        payload: {},
        meta: { clientId: "C1", clientTs: 1 },
        createdAt: 1,
      }),
    );

    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committedId: 1,
        created: 10,
      },
    });

    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-2",
          partitions: ["P1", "P2"],
          committedId: 2,
          type: "increment",
          payload: {},
          meta: { clientId: "C2", clientTs: 11 },
          created: 11,
        }),
      ],
      nextCursor: 2,
    });

    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-2",
          partitions: ["P1", "P2"],
          committedId: 2,
          type: "increment",
          payload: {},
          meta: { clientId: "C2", clientTs: 11 },
          created: 12,
        }),
      ],
      nextCursor: 2,
    });

    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P2",
      }),
    ).toEqual({ count: 1 });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P3",
      }),
    ).toEqual({ count: 0 });
  });

  it("supports batch loads, eviction, and invalidation for materialized views", async () => {
    const store = createInMemoryClientStore({
      materializedViews: [counterView],
    });

    await store.applyCommittedBatch({
      events: [
        makeCommitted({
          id: "evt-1",
          committedId: 1,
          type: "increment",
          payload: {},
          created: 10,
        }),
        makeCommitted({
          id: "evt-2",
          partitions: ["P1", "P2"],
          committedId: 2,
          type: "increment",
          payload: {},
          created: 11,
        }),
      ],
      nextCursor: 2,
    });

    expect(
      await store.loadMaterializedViews({
        viewName: "counter",
        partitions: ["P1", "P2"],
      }),
    ).toEqual({
      P1: { count: 2 },
      P2: { count: 1 },
    });

    await store.evictMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });

    await store.invalidateMaterializedView({
      viewName: "counter",
      partition: "P1",
    });
    expect(
      await store.loadMaterializedView({
        viewName: "counter",
        partition: "P1",
      }),
    ).toEqual({ count: 2 });

    await store.flushMaterializedViews();
  });

  it("requires explicit reduce in materialized view definitions", () => {
    expect(() =>
      createInMemoryClientStore({
        materializedViews: [
          {
            name: "counter",
            initialState: () => ({ count: 0 }),
          },
        ],
      }),
    ).toThrow("reduce must be a function");
  });
});
