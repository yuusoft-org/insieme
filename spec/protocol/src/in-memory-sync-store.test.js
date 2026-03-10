import { describe, expect, it } from "vitest";
import { createInMemorySyncStore } from "../../../src/index.js";

const makeSubmit = (overrides = {}) => ({
  id: "evt-1",
  partitions: ["P1"],
  projectId: "proj-1",
  userId: "u1",
  type: "x",
  payload: { n: 1 },
  meta: {
    clientId: "C1",
    clientTs: 1,
  },
  now: 100,
  ...overrides,
});

describe("src createInMemorySyncStore", () => {
  it("dedupes by id and normalized payload", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting(
      makeSubmit({
        partitions: ["P2", "P1"],
        payload: { a: 1, b: 2 },
      }),
    );

    const second = await store.commitOrGetExisting(
      makeSubmit({
        partitions: ["P1", "P2"],
        payload: { b: 2, a: 1 },
        now: 200,
      }),
    );

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committedId).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committedId).toBe(1);
  });

  it("rejects same id with different normalized payload", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting(makeSubmit());

    await expect(
      store.commitOrGetExisting(
        makeSubmit({
          payload: { n: 2 },
          now: 101,
        }),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("pages committed events with fixed upper bound", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting(makeSubmit({ id: "evt-1", payload: { n: 1 } }));
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-2", payload: { n: 2 }, now: 101 }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-3", payload: { n: 3 }, now: 102 }),
    );

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

  it("returns partition-scoped max committed id", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-1", partitions: ["P1"], payload: { n: 1 } }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p2-1", partitions: ["P2"], payload: { n: 2 }, now: 2 }),
    );
    await store.commitOrGetExisting(
      makeSubmit({ id: "evt-p1-2", partitions: ["P1"], payload: { n: 3 }, now: 3 }),
    );

    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P1"] }),
    ).resolves.toBe(3);
    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P2"] }),
    ).resolves.toBe(2);
    await expect(
      store.getMaxCommittedIdForPartitions({ partitions: ["P9"] }),
    ).resolves.toBe(0);
  });
});
