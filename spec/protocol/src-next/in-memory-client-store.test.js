import { describe, expect, it } from "vitest";
import { createInMemoryClientStore } from "../../../src-next/index.js";

describe("src-next createInMemoryClientStore", () => {
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
});
