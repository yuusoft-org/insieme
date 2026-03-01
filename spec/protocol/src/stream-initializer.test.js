import { describe, expect, it, vi } from "vitest";
import { initializeStreamIfEmpty } from "../../../src/index.js";

describe("src initializeStreamIfEmpty", () => {
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
});
