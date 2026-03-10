import { describe, expect, it } from "vitest";
import {
  commandToSyncEvent,
  committedSyncEventToCommand,
  projectIdFromPartitions,
  validateCommandSubmitItem,
} from "../../../src/index.js";

describe("src command-profile", () => {
  it("maps command envelope to normalized sync fields", () => {
    const command = {
      id: "cmd-1",
      type: "scene.create",
      payload: { sceneId: "scene-1", name: "Intro" },
      actor: { userId: "u1", clientId: "c1" },
      projectId: "proj-1",
      clientTs: 1000,
      commandVersion: 2,
    };

    expect(commandToSyncEvent(command)).toEqual({
      projectId: "proj-1",
      userId: "u1",
      type: "scene.create",
      payload: { sceneId: "scene-1", name: "Intro" },
      meta: { clientId: "c1", clientTs: 1000 },
    });
  });

  it("maps committed sync row to command envelope with partition project fallback", () => {
    const command = committedSyncEventToCommand({
      id: "cmd-1",
      partitions: ["project:proj-1:story", "project:proj-1:settings"],
      type: "scene.create",
      payload: {
        sceneId: "scene-1",
      },
      userId: "u1",
      meta: {
        clientId: "c1",
        clientTs: 1234,
      },
      created: 2000,
    });

    expect(command).toMatchObject({
      id: "cmd-1",
      projectId: "proj-1",
      type: "scene.create",
      partition: "project:proj-1:story",
      partitions: ["project:proj-1:story", "project:proj-1:settings"],
      clientTs: 1234,
      actor: { userId: "u1", clientId: "c1" },
    });
  });

  it("validates command submit item and normalizes partitions", () => {
    const result = validateCommandSubmitItem({
      id: "cmd-1",
      partitions: [
        "project:proj-1:settings",
        "project:proj-1:settings",
        "project:proj-1:story",
      ],
      type: "project.created",
      payload: { state: { project: { id: "proj-1" } } },
      userId: "u1",
      meta: {
        clientId: "c1",
        clientTs: 1000,
      },
    });

    expect(result).toEqual({
      commandId: "cmd-1",
      type: "project.created",
      projectId: "proj-1",
      userId: "u1",
      partitions: ["project:proj-1:settings", "project:proj-1:story"],
      meta: {
        clientId: "c1",
        clientTs: 1000,
      },
    });
  });

  it("rejects missing required normalized fields during command validation", () => {
    expect(() =>
      validateCommandSubmitItem({
        partitions: ["project:proj-1:story"],
        type: "",
        payload: {},
        meta: {
          clientId: "c1",
          clientTs: 1000,
        },
      }),
    ).toThrow("item.id is required");
  });

  it("extracts project id from partition scope", () => {
    expect(
      projectIdFromPartitions(["project:proj-42:story", "project:proj-42:layouts"]),
    ).toBe("proj-42");
    expect(projectIdFromPartitions(["workspace:abc"])).toBe(null);
  });
});
