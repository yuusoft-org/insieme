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
    setOnlineTransport: vi.fn(async () => {}),
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
              foo: "bar",
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
      meta: {
        clientId: "c2",
        clientTs: 1,
        foo: "bar",
      },
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
      meta: {
        foo: "bar",
        clientId: "user-provided-client",
        clientTs: 1,
      },
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
      meta: { foo: "bar", clientId: "c1", clientTs: 5 },
    });
  });

  it("exposes session helpers and clears local lastError state", async () => {
    const forwardedEvents = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      partitions: ["project:p1:story"],
      transport,
      store,
      onEvent: (entry) => {
        forwardedEvents.push(entry);
      },
    });

    expect(session.getActor()).toEqual({
      userId: "u1",
      clientId: "c1",
    });
    expect(session.getStatus()).toMatchObject({
      started: false,
      connected: false,
      activePartitions: ["project:p1:story"],
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

    expect(session.getStatus()).toMatchObject({
      started: true,
      connected: true,
      connectedServerLastCommittedId: 0,
    });

    const submittedId = await session.submitEvent({
      id: "evt-direct-1",
      partitions: ["project:p1:story"],
      projectId: "p1",
      userId: "u1",
      type: "scene.create",
      payload: { sceneId: "s2" },
      meta: { clientId: "c1", clientTs: 6 },
    });
    expect(submittedId).toBe("evt-direct-1");

    await session.syncNow({ sinceCommittedId: 0 });
    await session.flushDrafts();
    await session.setOnlineTransport({ transportId: "next" });

    expect(transport.setOnlineTransport).toHaveBeenCalledWith({
      transportId: "next",
    });
    expect(
      transport.sent.some((entry) => entry.type === "submit_events"),
    ).toBe(true);
    expect(transport.sent.some((entry) => entry.type === "sync")).toBe(true);

    transport.emit({
      type: "error",
      payload: {
        code: "server_error",
        message: "boom",
      },
    });
    await tick();

    expect(session.getLastError()).toMatchObject({
      code: "server_error",
      message: "boom",
    });
    session.clearLastError();
    expect(session.getLastError()).toBeNull();
    expect(forwardedEvents.some((entry) => entry.type === "error")).toBe(true);

    await session.stop();
    expect(transport.disconnect).toHaveBeenCalled();
    expect(session.getStatus()).toMatchObject({
      started: false,
      connected: false,
    });
  });
});
