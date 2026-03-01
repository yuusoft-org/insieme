import { describe, expect, it } from "vitest";
import {
  buildScopePartition,
  extractScopeId,
  extractScopeIds,
  parsePartitionScope,
  requireSingleScopeId,
} from "../../../src/index.js";

describe("src partition-scope", () => {
  it("parses scope/id/remainder from partition", () => {
    expect(parsePartitionScope("project:proj-1:resources:images")).toEqual({
      scope: "project",
      scopeId: "proj-1",
      remainder: ["resources", "images"],
    });
    expect(parsePartitionScope("bad")).toBe(null);
  });

  it("extracts scope id for matching scope", () => {
    expect(extractScopeId("project:proj-1:story", "project")).toBe("proj-1");
    expect(extractScopeId("workspace:ws-1:story", "project")).toBe(null);
  });

  it("extracts unique scope ids from partition arrays", () => {
    expect(
      extractScopeIds(
        [
          "project:proj-1:story",
          "project:proj-1:settings",
          "project:proj-2:story",
          "workspace:ws-1:story",
        ],
        "project",
      ),
    ).toEqual(["proj-1", "proj-2"]);
  });

  it("requires exactly one scope id", () => {
    expect(
      requireSingleScopeId({
        partitions: ["project:proj-1:story", "project:proj-1:settings"],
        scope: "project",
      }),
    ).toBe("proj-1");

    expect(() =>
      requireSingleScopeId({
        partitions: ["workspace:ws-1:story"],
        scope: "project",
      }),
    ).toThrow("No 'project' scope found in partitions");

    expect(() =>
      requireSingleScopeId({
        partitions: ["project:proj-1:story", "project:proj-2:story"],
        scope: "project",
      }),
    ).toThrow("Multiple 'project' scope ids are not allowed");
  });

  it("builds scoped partitions", () => {
    expect(
      buildScopePartition({
        scope: "project",
        scopeId: "proj-1",
        path: ["resources", "images"],
      }),
    ).toBe("project:proj-1:resources:images");
  });
});
