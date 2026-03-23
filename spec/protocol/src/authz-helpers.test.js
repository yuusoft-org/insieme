import { describe, expect, it } from "vitest";
import {
  authorizeProjectId,
  authorizeSingleScopeId,
} from "../../../src/index.js";

describe("src authorizeProjectId", () => {
  it("rejects missing identity, invalid project ids, and malformed claims", () => {
    expect(
      authorizeProjectId({
        identity: undefined,
        projectId: "proj-1",
      }),
    ).toBe(false);

    expect(
      authorizeProjectId({
        identity: { claims: { projectIds: ["proj-1"] } },
        projectId: "",
      }),
    ).toBe(false);

    expect(
      authorizeProjectId({
        identity: { claims: { projectIds: "proj-1" } },
        projectId: "proj-1",
      }),
    ).toBe(false);
  });

  it("authorizes allowed projects, custom claims fields, and allowAll", () => {
    expect(
      authorizeProjectId({
        identity: { claims: { projectIds: ["proj-1"] } },
        projectId: "proj-1",
      }),
    ).toBe(true);

    expect(
      authorizeProjectId({
        identity: { claims: { workspaceIds: ["proj-2"] } },
        projectId: "proj-2",
        claimsField: "workspaceIds",
      }),
    ).toBe(true);

    expect(
      authorizeProjectId({
        identity: { claims: { userId: "u1" } },
        projectId: "proj-9",
        allowAll: true,
      }),
    ).toBe(true);
  });
});

describe("src authorizeSingleScopeId", () => {
  it("rejects missing identity or partition", () => {
    expect(
      authorizeSingleScopeId({
        identity: undefined,
        partition: "project:proj-1:story",
      }),
    ).toBe(false);
    expect(
      authorizeSingleScopeId({
        identity: { claims: { projectIds: ["proj-1"] } },
        partition: "",
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
      partition: "project:proj-1:story",
      scope: "project",
    });
    expect(ok).toBe(true);
  });

  it("rejects when the partition does not match the requested scope", () => {
    const ok = authorizeSingleScopeId({
      identity: {
        claims: {
          projectIds: ["proj-1", "proj-2"],
        },
      },
      partition: "workspace:ws-1:story",
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
      partition: "project:proj-9:story",
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
        partition: "project:proj-9:story",
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
        partition: "project:proj-9:story",
        scope: "project",
      }),
    ).toBe(false);
  });
});
