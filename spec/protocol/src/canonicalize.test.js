import { describe, expect, it } from "vitest";
import {
  canonicalizeSubmitItem,
  deepSortKeys,
  intersectsPartitions,
  normalizePartitionSet,
} from "../../../src/canonicalize.js";

describe("src canonicalize", () => {
  it("deep sorts object keys while preserving array order", () => {
    expect(
      deepSortKeys({
        z: 1,
        a: { y: 2, x: 1 },
        list: [{ b: 2, a: 1 }],
      }),
    ).toEqual({
      a: { x: 1, y: 2 },
      list: [{ a: 1, b: 2 }],
      z: 1,
    });
  });

  it("normalizes partition sets and ignores invalid entries", () => {
    expect(normalizePartitionSet(["b", "", "a", "b", 1, "a"])).toEqual([
      "a",
      "b",
    ]);
    expect(normalizePartitionSet("not-array")).toEqual([]);
  });

  it("detects partition intersections defensively", () => {
    expect(intersectsPartitions(["a", "b"], ["c", "b"])).toBe(true);
    expect(intersectsPartitions(["a"], ["b"])).toBe(false);
    expect(intersectsPartitions([], ["b"])).toBe(false);
    expect(intersectsPartitions(["a"], null)).toBe(false);
  });

  it("canonicalizes stored-shape events by sorted partitions and deep-sorted event", () => {
    const left = canonicalizeSubmitItem({
      partitions: ["z", "a", "z"],
      event: {
        type: "event",
        payload: {
          schema: "task.updated",
          schemaVersion: 1,
          data: { b: 2, a: 1 },
        },
      },
    });
    const right = canonicalizeSubmitItem({
      partitions: ["a", "z"],
      event: {
        payload: {
          data: { a: 1, b: 2 },
          schemaVersion: 1,
          schema: "task.updated",
        },
        type: "event",
      },
    });

    expect(right).toBe(left);
  });

  it("canonicalizes legacy submit items without client identity metadata", () => {
    const canonical = canonicalizeSubmitItem({
      partition: "P1",
      projectId: "proj-1",
      userId: "U1",
      type: "task.updated",
      schemaVersion: 1,
      payload: { b: 2, a: 1 },
      meta: { clientId: "C1", clientTs: 123, extra: "keep" },
    });

    expect(JSON.parse(canonical)).toEqual({
      meta: { clientTs: 123, extra: "keep" },
      partition: "P1",
      payload: { a: 1, b: 2 },
      projectId: "proj-1",
      schemaVersion: 1,
      type: "task.updated",
      userId: "U1",
    });
  });
});
