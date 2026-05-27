import { describe, expect, it } from "vitest";
import { createInMemorySyncStore } from "../../src/index.js";

const makeSubmit = (overrides = {}) => ({
  id: "evt-1",
  partition: "P1",
  projectId: "proj-1",
  type: "x",
  schemaVersion: 1,
  payload: { n: 1 },
  meta: {
    clientId: "C1",
    clientTs: 1,
  },
  now: 100,
  ...overrides,
});

describe("regression: event deduplication", () => {
  it("dedupes identical event submitted twice", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting(makeSubmit());
    const second = await store.commitOrGetExisting(makeSubmit());

    expect(first.deduped).toBe(false);
    expect(first.committedEvent.committedId).toBe(1);
    expect(second.deduped).toBe(true);
    expect(second.committedEvent.committedId).toBe(1);
  });

  it("dedupes event with reordered payload keys", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting(
      makeSubmit({ payload: { a: 1, b: 2, c: 3 } }),
    );
    const second = await store.commitOrGetExisting(
      makeSubmit({ payload: { c: 3, a: 1, b: 2 } }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(first.committedEvent.committedId).toBe(
      second.committedEvent.committedId,
    );
  });

  it("rejects same id with different payload content", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting(makeSubmit({ payload: { n: 1 } }));

    await expect(
      store.commitOrGetExisting(makeSubmit({ payload: { n: 2 }, now: 200 })),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects same id with different type", async () => {
    const store = createInMemorySyncStore();

    await store.commitOrGetExisting(makeSubmit({ type: "x" }));

    await expect(
      store.commitOrGetExisting(makeSubmit({ type: "y" })),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("allows different ids with identical payloads", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting(
      makeSubmit({ id: "evt-1", payload: { n: 1 } }),
    );
    const second = await store.commitOrGetExisting(
      makeSubmit({ id: "evt-2", payload: { n: 1 }, now: 200 }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(first.committedEvent.committedId).toBe(1);
    expect(second.committedEvent.committedId).toBe(2);
  });

  it("dedupes event with different now timestamp", async () => {
    const store = createInMemorySyncStore();

    const first = await store.commitOrGetExisting(
      makeSubmit({ now: 100 }),
    );
    const second = await store.commitOrGetExisting(
      makeSubmit({ now: 9999 }),
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
  });
});
