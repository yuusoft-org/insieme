import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandSyncSession } from "../../../src/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createMockTransport = () => {
  let onMessageHandler = null;
  const sent = [];

  return {
    sent,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (message) => {
      sent.push(message);
    }),
    onMessage: vi.fn((handler) => {
      onMessageHandler = handler;
      return () => {
        onMessageHandler = null;
      };
    }),
    emit(message) {
      if (onMessageHandler) onMessageHandler(message);
    },
  };
};

const createMockStore = () => ({
  init: vi.fn(async () => {}),
  loadCursor: vi.fn(async () => 0),
  insertDraft: vi.fn(async () => {}),
  loadDraftsOrdered: vi.fn(async () => []),
  applySubmitResult: vi.fn(async () => {}),
  applyCommittedBatch: vi.fn(async () => {}),
});

describe("src createCommandSyncSession", () => {
  let transport;
  let store;

  beforeEach(() => {
    transport = createMockTransport();
    store = createMockStore();
  });

  it("maps committed events to commands and emits callback once", async () => {
    const committedCalls = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      partitions: ["project:p1:story"],
      transport,
      store,
      onCommittedCommand: (payload) => {
        committedCalls.push(payload);
      },
    });

    await session.start();

    transport.emit({
      type: "connected",
      payload: { clientId: "c1", globalLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["project:p1:story"],
        events: [
          {
            id: "cmd-1",
            projectId: "p1",
            userId: "u2",
            partitions: ["project:p1:story"],
            committedId: 1,
            type: "scene.create",
            payload: {
              sceneId: "s1",
            },
            meta: {
              clientId: "c2",
              clientTs: 1,
            },
            created: 1,
          },
        ],
        nextSinceCommittedId: 1,
        hasMore: false,
      },
    });
    await tick();

    expect(committedCalls).toHaveLength(1);
    expect(committedCalls[0].command).toMatchObject({
      id: "cmd-1",
      projectId: "p1",
      type: "scene.create",
      payload: { sceneId: "s1" },
      actor: { userId: "u2", clientId: "c2" },
    });
  });

  it("submits command via sync client with command id as submit id", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      partitions: ["project:p1:story"],
      transport,
      store,
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", globalLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        partitions: ["project:p1:story"],
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    const commandId = await session.submitCommand({
      id: "cmd-local-1",
      type: "scene.create",
      payload: { sceneId: "s1" },
      actor: { userId: "u1", clientId: "c1" },
      projectId: "p1",
      clientTs: 5,
      partitions: ["project:p1:story"],
    });

    expect(commandId).toBe("cmd-local-1");
    const submit = transport.sent.find((entry) => entry.type === "submit_events");
    expect(submit).toBeTruthy();
    expect(submit.payload.events[0]).toMatchObject({
      id: "cmd-local-1",
      projectId: "p1",
      userId: "u1",
      type: "scene.create",
      payload: { sceneId: "s1" },
      meta: { clientId: "c1", clientTs: 5 },
    });
  });
});
