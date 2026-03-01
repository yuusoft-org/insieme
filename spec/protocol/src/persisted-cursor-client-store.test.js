import { describe, expect, it, vi } from "vitest";
import { createPersistedCursorClientStore } from "../../../src/index.js";

const createMockStore = () => {
  let cursor = 0;
  return {
    init: vi.fn(async () => {}),
    loadCursor: vi.fn(async () => cursor),
    insertDraft: vi.fn(async () => {}),
    loadDraftsOrdered: vi.fn(async () => []),
    applySubmitResult: vi.fn(async () => {}),
    applyCommittedBatch: vi.fn(async ({ nextCursor }) => {
      if (Number.isFinite(Number(nextCursor))) {
        cursor = Math.max(cursor, Math.floor(Number(nextCursor)));
      }
    }),
  };
};

describe("src createPersistedCursorClientStore", () => {
  it("hydrates persisted cursor on init and returns max cursor", async () => {
    const base = createMockStore();
    const wrapped = createPersistedCursorClientStore({
      store: base,
      loadPersistedCursor: async () => 12,
      savePersistedCursor: async () => {},
    });

    await wrapped.init();
    const cursor = await wrapped.loadCursor();

    expect(cursor).toBe(12);
    expect(base.applyCommittedBatch).toHaveBeenCalledWith({
      events: [],
      nextCursor: 12,
    });
  });

  it("persists committed cursor monotonically", async () => {
    const base = createMockStore();
    const saves = [];
    const wrapped = createPersistedCursorClientStore({
      store: base,
      loadPersistedCursor: async () => 0,
      savePersistedCursor: async (cursor) => {
        saves.push(cursor);
      },
    });

    await wrapped.init();
    await wrapped.applyCommittedBatch({
      events: [],
      nextCursor: 3,
    });
    await wrapped.applyCommittedBatch({
      events: [],
      nextCursor: 2,
    });
    await wrapped.applyCommittedBatch({
      events: [],
      nextCursor: 9,
    });

    expect(saves).toEqual([3, 9]);
    expect(await wrapped.loadCursor()).toBe(9);
  });
});
