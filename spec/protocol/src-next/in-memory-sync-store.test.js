import { describe, expect, it } from "vitest";
import { createInMemorySyncStore } from "../../../src-next/index.js";

describe("src-next createInMemorySyncStore", () => {
  it("dedupes by id and canonical payload", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P2", "P1"],
      event: { type: "event", payload: { schema: "x", data: { a: 1, b: 2 } } },
      now: 100,
    });

    const second = await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1", "P2"],
      event: { type: "event", payload: { data: { b: 2, a: 1 }, schema: "x" } },
      now: 200,
    });

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committed_id).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committed_id).toBe(1);
  });

  it("rejects same id with different canonical payload", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      now: 100,
    });

    await expect(
      store.commitOrGetExisting({
        id: "evt-1",
        clientId: "C1",
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
        now: 101,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("pages committed events with fixed upper bound", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting({
      id: "evt-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      now: 100,
    });
    await store.commitOrGetExisting({
      id: "evt-2",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      now: 101,
    });
    await store.commitOrGetExisting({
      id: "evt-3",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      now: 102,
    });

    const first = await store.listCommittedSince({
      partitions: ["P1"],
      sinceCommittedId: 0,
      limit: 1,
      syncToCommittedId: 2,
    });

    const second = await store.listCommittedSince({
      partitions: ["P1"],
      sinceCommittedId: first.nextSinceCommittedId,
      limit: 10,
      syncToCommittedId: 2,
    });

    expect(first.events.map((event) => event.id)).toEqual(["evt-1"]);
    expect(first.hasMore).toBe(true);

    expect(second.events.map((event) => event.id)).toEqual(["evt-2"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextSinceCommittedId).toBe(2);
  });
});
