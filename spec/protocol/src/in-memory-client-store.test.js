import { describe, expect, it } from "vitest";
import { createInMemoryClientStore } from "../../../src/index.js";

describe("src createInMemoryClientStore", () => {
  it("orders drafts by draftClock then id", async () => {
    const store = createInMemoryClientStore();
    await store.init();

    await store.insertDraft({
      id: "b",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });
    await store.insertDraft({
      id: "a",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      createdAt: 101,
    });

    const drafts = await store.loadDraftsOrdered();
    expect(drafts.map((draft) => draft.id)).toEqual(["b", "a"]);
  });

  it("applies committed submit result atomically (commit insert + draft cleanup)", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });

    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committed_id: 10,
        status_updated_at: 111,
      },
      fallbackClientId: "C1",
    });

    const drafts = store._debug.getDrafts();
    const committed = store._debug.getCommitted();

    expect(drafts).toHaveLength(0);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      id: "evt-1",
      committed_id: 10,
      client_id: "C1",
    });
  });

  it("applies rejected submit result by removing draft only", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft({
      id: "evt-r",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });

    await store.applySubmitResult({
      result: {
        id: "evt-r",
        status: "rejected",
        reason: "validation_failed",
        status_updated_at: 111,
      },
      fallbackClientId: "C1",
    });

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(store._debug.getCommitted()).toHaveLength(0);
  });

  it("applies committed batches idempotently and updates cursor", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 100,
    });

    const events = [
      {
        id: "evt-1",
        client_id: "C1",
        partitions: ["P1"],
        committed_id: 1,
        event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
        status_updated_at: 10,
      },
      {
        id: "evt-2",
        client_id: "C2",
        partitions: ["P1"],
        committed_id: 2,
        event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
        status_updated_at: 11,
      },
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
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          status_updated_at: 10,
        },
      ],
      nextCursor: 1,
    });

    await expect(
      store.applyCommittedBatch({
        events: [
          {
            id: "evt-1",
            client_id: "C1",
            partitions: ["P1"],
            committed_id: 2,
            event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
            status_updated_at: 11,
          },
        ],
        nextCursor: 2,
      }),
    ).rejects.toThrow("committed event invariant violation");
  });

  it("maintains materialized views per partition across commit paths", async () => {
    const store = createInMemoryClientStore({
      materializedViews: [
        {
          name: "counter",
          initialState: () => ({ count: 0 }),
          reduce: ({ state, event }) => ({
            count: state.count + (event.event.type === "increment" ? 1 : 0),
          }),
        },
      ],
    });

    await store.insertDraft({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "increment", payload: {} },
      createdAt: 1,
    });

    await store.applySubmitResult({
      result: {
        id: "evt-1",
        status: "committed",
        committed_id: 1,
        status_updated_at: 10,
      },
      fallbackClientId: "C1",
    });

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-2",
          client_id: "C2",
          partitions: ["P1", "P2"],
          committed_id: 2,
          event: { type: "increment", payload: {} },
          status_updated_at: 11,
        },
      ],
      nextCursor: 2,
    });

    // Duplicate batch item should not re-apply reducer state.
    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-2",
          client_id: "C2",
          partitions: ["P1", "P2"],
          committed_id: 2,
          event: { type: "increment", payload: {} },
          status_updated_at: 12,
        },
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

  it("uses built-in reducer when materialized view reduce is omitted", async () => {
    const store = createInMemoryClientStore({
      materializedViews: [
        {
          name: "tree-projection",
          initialState: () => ({}),
        },
      ],
    });

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-tree-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: {
            type: "treePush",
            payload: {
              target: "explorer",
              value: { id: "A", name: "Folder A", type: "folder" },
              options: { parent: "_root", position: "first" },
            },
          },
          status_updated_at: 10,
        },
      ],
      nextCursor: 1,
    });

    expect(
      await store.loadMaterializedView({
        viewName: "tree-projection",
        partition: "P1",
      }),
    ).toEqual({
      explorer: {
        items: {
          A: { id: "A", name: "Folder A", type: "folder" },
        },
        tree: [{ id: "A", children: [] }],
      },
    });
  });
});
