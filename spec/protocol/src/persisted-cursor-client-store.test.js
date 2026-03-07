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
  it("validates the wrapped store contract", () => {
    expect(() => createPersistedCursorClientStore({})).toThrow(
      "createPersistedCursorClientStore: store is required",
    );
    expect(() =>
      createPersistedCursorClientStore({ store: {} }),
    ).toThrow("createPersistedCursorClientStore: store.init is required");
    expect(() =>
      createPersistedCursorClientStore({
        store: {
          init: async () => {},
        },
      }),
    ).toThrow("createPersistedCursorClientStore: store.loadCursor is required");
    expect(() =>
      createPersistedCursorClientStore({
        store: {
          init: async () => {},
          loadCursor: async () => 0,
        },
      }),
    ).toThrow(
      "createPersistedCursorClientStore: store.applyCommittedBatch is required",
    );
  });

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

  it("normalizes invalid cursor values and logs save failures without throwing", async () => {
    const base = createMockStore();
    base.loadCursor.mockResolvedValueOnce(-5).mockResolvedValue(4);
    const logger = vi.fn();
    const wrapped = createPersistedCursorClientStore({
      store: base,
      loadPersistedCursor: async () => "not-a-number",
      savePersistedCursor: async () => {
        throw new Error("disk full");
      },
      logger,
    });

    await wrapped.init();
    expect(await wrapped.loadCursor()).toBe(0);

    await wrapped.applyCommittedBatch({
      events: [],
      nextCursor: -100,
    });
    await wrapped.applyCommittedBatch({
      events: [],
      nextCursor: 7.9,
    });

    expect(logger.mock.calls).toEqual([
      [
        {
          component: "persisted_cursor_store",
          event: "persist_cursor_failed",
          cursor: 4,
          message: "disk full",
        },
      ],
      [
        {
          component: "persisted_cursor_store",
          event: "persist_cursor_failed",
          cursor: 7,
          message: "disk full",
        },
      ],
    ]);
    expect(await wrapped.loadCursor()).toBe(7);
  });
});
