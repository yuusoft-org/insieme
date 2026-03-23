import { describe, expect, it } from "vitest";
import {
  commandToSyncEvent,
  committedSyncEventToCommand,
  validateCommandSubmitItem,
} from "../../../src/index.js";

describe("src command-profile", () => {
  it("maps command envelope to normalized sync fields", () => {
    const command = {
      id: "cmd-1",
      partition: "project:proj-1:story",
      type: "scene.create",
      payload: { sceneId: "scene-1", name: "Intro" },
      meta: {
        foo: "bar",
        clientId: "user-provided-client",
        clientTs: 1,
      },
      actor: { userId: "u1", clientId: "c1" },
      projectId: "proj-1",
      clientTs: 1000,
      schemaVersion: 2,
    };

    expect(commandToSyncEvent(command)).toEqual({
      partition: "project:proj-1:story",
      projectId: "proj-1",
      userId: "u1",
      type: "scene.create",
      schemaVersion: 2,
      payload: { sceneId: "scene-1", name: "Intro" },
      meta: { foo: "bar", clientId: "c1", clientTs: 1000 },
    });
  });

  it("uses the default schemaVersion when the command omits one", () => {
    expect(
      commandToSyncEvent(
        {
          id: "cmd-default-schema",
          partition: "project:proj-1:story",
          type: "scene.create",
          payload: { sceneId: "scene-1" },
          actor: { userId: "u1", clientId: "c1" },
          projectId: "proj-1",
          clientTs: 1000,
        },
        { defaultSchemaVersion: 7 },
      ),
    ).toMatchObject({
      partition: "project:proj-1:story",
      projectId: "proj-1",
      userId: "u1",
      type: "scene.create",
      schemaVersion: 7,
      meta: { clientId: "c1", clientTs: 1000 },
    });
  });

  it("maps committed sync row to command envelope", () => {
    const command = committedSyncEventToCommand({
      id: "cmd-1",
      projectId: "proj-1",
      partition: "project:proj-1:story",
      type: "scene.create",
      payload: {
        sceneId: "scene-1",
      },
      userId: "u1",
      schemaVersion: 2,
      meta: {
        clientId: "c1",
        clientTs: 1234,
        foo: "bar",
      },
      serverTs: 2000,
    });

    expect(command).toMatchObject({
      id: "cmd-1",
      projectId: "proj-1",
      type: "scene.create",
      partition: "project:proj-1:story",
      clientTs: 1234,
      schemaVersion: 2,
      meta: {
        clientId: "c1",
        clientTs: 1234,
        foo: "bar",
      },
      actor: { userId: "u1", clientId: "c1" },
    });
  });

  it("falls back to serverTs when committed meta omits clientTs", () => {
    expect(
      committedSyncEventToCommand({
        id: "cmd-server-ts",
        partition: "project:proj-1:story",
        type: "scene.create",
        schemaVersion: 1,
        payload: { sceneId: "scene-1" },
        meta: { clientId: "c1" },
        serverTs: 4321,
      }),
    ).toMatchObject({
      id: "cmd-server-ts",
      projectId: undefined,
      actor: { userId: undefined, clientId: "c1" },
      clientTs: 4321,
    });
  });

  it("returns null when the committed event is malformed", () => {
    expect(
      committedSyncEventToCommand({
        id: "cmd-invalid",
        partition: "project:proj-1:story",
        type: "scene.create",
        schemaVersion: 1,
        payload: null,
      }),
    ).toBeNull();
  });

  it("preserves arbitrary normalized meta on validation", () => {
    const result = validateCommandSubmitItem({
      id: "cmd-2",
      partition: "project:proj-1:story",
      projectId: "proj-1",
      type: "scene.update",
      schemaVersion: 1,
      payload: { sceneId: "scene-1" },
      meta: {
        clientId: "c1",
        clientTs: 1000,
        foo: "bar",
        nested: { ok: true },
      },
    });

    expect(result.meta).toEqual({
      clientId: "c1",
      clientTs: 1000,
      foo: "bar",
      nested: { ok: true },
    });
  });

  it("validates command submit item and normalizes partitions", () => {
    const result = validateCommandSubmitItem({
      id: "cmd-1",
      partition: "project:proj-1:story",
      projectId: "proj-1",
      type: "project.created",
      schemaVersion: 1,
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
      partition: "project:proj-1:story",
      schemaVersion: 1,
      meta: {
        clientId: "c1",
        clientTs: 1000,
      },
    });
  });

  it("rejects missing required normalized fields during command validation", () => {
    expect(() =>
      validateCommandSubmitItem({
        partition: "project:proj-1:story",
        projectId: "proj-1",
        type: "",
        schemaVersion: 1,
        payload: {},
        meta: {
          clientId: "c1",
          clientTs: 1000,
        },
      }),
    ).toThrow("item.id is required");
  });

  it("rejects invalid optional and project-scoped validation fields", () => {
    expect(() =>
      validateCommandSubmitItem({
        id: "cmd-bad-user",
        partition: "project:proj-1:story",
        projectId: "proj-1",
        type: "scene.update",
        schemaVersion: 1,
        payload: {},
        userId: "",
        meta: {
          clientId: "c1",
          clientTs: 1000,
        },
      }),
    ).toThrow("item.userId must be a non-empty string when provided");

    expect(() =>
      validateCommandSubmitItem({
        id: "cmd-missing-project",
        partition: "project:proj-1:story",
        type: "scene.update",
        schemaVersion: 1,
        payload: {},
        meta: {
          clientId: "c1",
          clientTs: 1000,
        },
      }),
    ).toThrow("item.projectId is required");

    expect(() =>
      validateCommandSubmitItem({
        id: "cmd-missing-client",
        partition: "project:proj-1:story",
        projectId: "proj-1",
        type: "scene.update",
        schemaVersion: 1,
        payload: {},
        meta: {
          clientTs: 1000,
        },
      }),
    ).toThrow("item.meta.clientId is required");

    expect(() =>
      validateCommandSubmitItem({
        id: "cmd-bad-client-ts",
        partition: "project:proj-1:story",
        projectId: "proj-1",
        type: "scene.update",
        schemaVersion: 1,
        payload: {},
        meta: {
          clientId: "c1",
          clientTs: Number.NaN,
        },
      }),
    ).toThrow("item.meta.clientTs must be a finite number");
  });
});
