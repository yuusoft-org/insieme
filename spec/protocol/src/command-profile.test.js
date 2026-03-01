import { describe, expect, it } from "vitest";
import {
  commandToSyncEvent,
  committedSyncEventToCommand,
  projectIdFromPartitions,
  validateCommandSubmitItem,
} from "../../../src/index.js";

describe("src command-profile", () => {
  it("maps command envelope to sync event envelope", () => {
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
      type: "event",
      payload: {
        commandId: "cmd-1",
        schema: "scene.create",
        data: { sceneId: "scene-1", name: "Intro" },
        commandVersion: 2,
        actor: { userId: "u1", clientId: "c1" },
        projectId: "proj-1",
        clientTs: 1000,
      },
    });
  });

  it("maps committed sync row to command envelope with partition project fallback", () => {
    const command = committedSyncEventToCommand({
      id: "evt-1",
      client_id: "client-1",
      partitions: ["project:proj-1:story", "project:proj-1:settings"],
      event: {
        type: "event",
        payload: {
          commandId: "cmd-1",
          schema: "scene.create",
          data: { sceneId: "scene-1" },
          actor: { userId: "u1", clientId: "c1" },
          clientTs: 1234,
        },
      },
      status_updated_at: 2000,
    });

    expect(command).toMatchObject({
      id: "cmd-1",
      projectId: "proj-1",
      type: "scene.create",
      partition: "project:proj-1:story",
      partitions: ["project:proj-1:story", "project:proj-1:settings"],
      clientTs: 1234,
    });
  });

  it("validates command submit item and normalizes partitions", () => {
    const result = validateCommandSubmitItem({
      id: "evt-1",
      partitions: [
        "project:proj-1:settings",
        "project:proj-1:settings",
        "project:proj-1:story",
      ],
      event: {
        type: "event",
        payload: {
          commandId: "cmd-1",
          schema: "project.created",
          data: { state: { project: { id: "proj-1" } } },
          actor: { userId: "u1", clientId: "c1" },
          clientTs: 1000,
        },
      },
    });

    expect(result).toEqual({
      commandId: "cmd-1",
      schema: "project.created",
      projectId: "proj-1",
      partitions: ["project:proj-1:settings", "project:proj-1:story"],
    });
  });

  it("rejects unsupported event type during command validation", () => {
    expect(() =>
      validateCommandSubmitItem({
        partitions: ["project:proj-1:story"],
        event: {
          type: "resource.created",
          payload: {},
        },
      }),
    ).toThrow("Unsupported item.event.type");
  });

  it("extracts project id from partition scope", () => {
    expect(
      projectIdFromPartitions(["project:proj-42:story", "project:proj-42:layouts"]),
    ).toBe("proj-42");
    expect(projectIdFromPartitions(["workspace:abc"])).toBe(null);
  });
});
