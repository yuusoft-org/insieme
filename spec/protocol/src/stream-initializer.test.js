import { describe, expect, it, vi } from "vitest";
import { initializeStreamIfEmpty } from "../../../src/index.js";

describe("src initializeStreamIfEmpty", () => {
  it("validates the sync client contract", async () => {
    await expect(
      initializeStreamIfEmpty({
        syncClient: {},
      }),
    ).rejects.toThrow("initializeStreamIfEmpty: syncClient.syncNow is required");

    await expect(
      initializeStreamIfEmpty({
        syncClient: {
          syncNow: async () => {},
        },
      }),
    ).rejects.toThrow(
      "initializeStreamIfEmpty: syncClient.submitEvent is required",
    );
  });

  it("does not seed when remote stream is non-empty", async () => {
    const syncClient = {
      syncNow: vi.fn(async () => {}),
      getStatus: () => ({ connectedServerLastCommittedId: 5 }),
      submitEvent: vi.fn(async () => "id-1"),
      flushDrafts: vi.fn(async () => {}),
    };

    const result = await initializeStreamIfEmpty({
      syncClient,
      seedEvents: [{ partitions: ["project:p1:story"], event: { type: "event", payload: {} } }],
    });

    expect(result).toMatchObject({
      initialized: false,
      reason: "remote_not_empty",
      submittedCount: 0,
    });
    expect(syncClient.submitEvent).not.toHaveBeenCalled();
  });

  it("returns server_cursor_unknown when remote cursor is unavailable", async () => {
    const syncClient = {
      syncNow: vi.fn(async () => {}),
      getStatus: () => ({ connectedServerLastCommittedId: "not-a-number" }),
      submitEvent: vi.fn(async () => "id-1"),
    };

    const result = await initializeStreamIfEmpty({
      syncClient,
      seedEvents: [{ partitions: ["project:p1:story"], event: { type: "event", payload: {} } }],
    });

    expect(result).toEqual({
      initialized: false,
      reason: "server_cursor_unknown",
      submittedCount: 0,
      serverLastCommittedId: null,
    });
    expect(syncClient.submitEvent).not.toHaveBeenCalled();
  });

  it("returns no_seed_events when the remote stream is empty but no seeds are provided", async () => {
    const syncClient = {
      syncNow: vi.fn(async () => {}),
      getStatus: () => ({ connectedServerLastCommittedId: -10 }),
      submitEvent: vi.fn(async () => "id-1"),
    };

    const result = await initializeStreamIfEmpty({
      syncClient,
      seedEvents: [],
    });

    expect(result).toEqual({
      initialized: false,
      reason: "no_seed_events",
      submittedCount: 0,
      serverLastCommittedId: 0,
    });
  });

  it("submits seed events when remote stream is empty", async () => {
    const syncClient = {
      syncNow: vi.fn(async () => {}),
      getStatus: () => ({ connectedServerLastCommittedId: 0 }),
      submitEvent: vi.fn(async () => "id-1"),
      flushDrafts: vi.fn(async () => {}),
    };

    const result = await initializeStreamIfEmpty({
      syncClient,
      seedEvents: [
        { partitions: ["project:p1:story"], event: { type: "event", payload: { a: 1 } } },
      ],
    });

    expect(result).toMatchObject({
      initialized: true,
      reason: "seed_submitted",
      submittedCount: 1,
    });
    expect(syncClient.submitEvent).toHaveBeenCalledTimes(1);
    expect(syncClient.flushDrafts).toHaveBeenCalledTimes(1);
  });

  it("validates seed entries and works without flushDrafts", async () => {
    const logger = vi.fn();
    const syncClient = {
      syncNow: vi.fn(async () => {}),
      submitEvent: vi.fn(async () => "id-1"),
    };

    await expect(
      initializeStreamIfEmpty({
        syncClient: {
          ...syncClient,
          getStatus: () => ({ connectedServerLastCommittedId: 0 }),
        },
        seedEvents: [{ partitions: ["project:p1:story"] }],
      }),
    ).rejects.toThrow(
      "initializeStreamIfEmpty: each seed event needs partitions and event",
    );

    const result = await initializeStreamIfEmpty({
      syncClient: {
        ...syncClient,
        getStatus: () => ({ connectedServerLastCommittedId: 0 }),
      },
      seedEvents: [
        {
          partitions: ["project:p1:story"],
          event: { type: "event", payload: { a: 1 } },
        },
      ],
      logger,
    });

    expect(result.reason).toBe("seed_submitted");
    expect(logger).toHaveBeenCalledWith({
      component: "stream_initializer",
      event: "seed_events_submitted",
      submitted_count: 1,
    });
  });
});
