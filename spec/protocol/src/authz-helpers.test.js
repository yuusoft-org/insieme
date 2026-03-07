import { describe, expect, it } from "vitest";
import { authorizeSingleScopeId } from "../../../src/index.js";

describe("src authorizeSingleScopeId", () => {
  it("rejects missing identity or partitions", () => {
    expect(
      authorizeSingleScopeId({
        identity: undefined,
        partitions: ["project:proj-1:story"],
      }),
    ).toBe(false);
    expect(
      authorizeSingleScopeId({
        identity: { claims: { projectIds: ["proj-1"] } },
        partitions: [],
      }),
    ).toBe(false);
  });

  it("authorizes when exactly one scope id is present and claims allow it", () => {
    const ok = authorizeSingleScopeId({
      identity: {
        claims: {
          projectIds: ["proj-1"],
        },
      },
      partitions: ["project:proj-1:story"],
      scope: "project",
    });
    expect(ok).toBe(true);
  });

  it("rejects when multiple scope ids are present", () => {
    const ok = authorizeSingleScopeId({
      identity: {
        claims: {
          projectIds: ["proj-1", "proj-2"],
        },
      },
      partitions: ["project:proj-1:story", "project:proj-2:settings"],
      scope: "project",
    });
    expect(ok).toBe(false);
  });

  it("allows all when allowAll is true", () => {
    const ok = authorizeSingleScopeId({
      identity: {
        claims: {
          userId: "u1",
        },
      },
      partitions: ["project:proj-9:story"],
      scope: "project",
      allowAll: true,
    });
    expect(ok).toBe(true);
  });

  it("supports custom claims fields and rejects malformed claims", () => {
    expect(
      authorizeSingleScopeId({
        identity: {
          claims: {
            workspaceIds: ["proj-9"],
          },
        },
        partitions: ["project:proj-9:story"],
        scope: "project",
        claimsField: "workspaceIds",
      }),
    ).toBe(true);

    expect(
      authorizeSingleScopeId({
        identity: {
          claims: {
            projectIds: "proj-9",
          },
        },
        partitions: ["project:proj-9:story"],
        scope: "project",
      }),
    ).toBe(false);
  });
});
