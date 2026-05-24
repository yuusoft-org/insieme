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

const createMockStore = () => {
  /** @type {object[]} */
  const drafts = [];
  let cursor = 0;
  const clone = (value) => structuredClone(value);
  const removeDraftById = (id) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index >= 0) drafts.splice(index, 1);
  };

  return {
    init: vi.fn(async () => {}),
    loadCursor: vi.fn(async () => cursor),
    insertDraft: vi.fn(async (item) => {
      drafts.push(clone(item));
    }),
    loadDraftsOrdered: vi.fn(async () => drafts.map(clone)),
    applySubmitResult: vi.fn(async ({ result }) => {
      if (result?.status === "committed" || result?.status === "rejected") {
        removeDraftById(result.id);
      }
    }),
    applyCommittedBatch: vi.fn(async ({ events, nextCursor }) => {
      for (const event of events || []) {
        removeDraftById(event.id);
      }
      if (typeof nextCursor === "number") {
        cursor = nextCursor;
      }
    }),
  };
};

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
      projectId: "p1",
      transport,
      store,
      onCommittedCommand: (payload) => {
        committedCalls.push(payload);
      },
    });

    await session.start();

    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [
          {
            id: "cmd-1",
            projectId: "p1",
            userId: "u2",
            partition: "project:p1:story",
            committedId: 1,
            type: "scene.create",
            schemaVersion: 1,
            payload: {
              sceneId: "s1",
            },
            meta: {
              clientId: "c2",
              clientTs: 1,
              foo: "bar",
            },
            serverTs: 1,
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

  it("maps JSON-serialized stored sync events to commands", async () => {
    const committedCalls = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport,
      store,
      onCommittedCommand: (payload) => {
        committedCalls.push(payload);
      },
    });

    await session.start();

    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();

    const storedEvent = JSON.parse(
      JSON.stringify({
        committed_id: 1,
        id: "cmd-json-1",
        client_id: "c2",
        partitions: ["p1", "project:p1:story"],
        event: {
          type: "event",
          payload: {
            schema: "scene.create",
            schemaVersion: 1,
            data: { sceneId: "s1" },
          },
        },
        status_updated_at: 1,
      }),
    );

    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [storedEvent],
        nextSinceCommittedId: 1,
        hasMore: false,
      },
    });
    await tick();

    expect(committedCalls).toHaveLength(1);
    expect(committedCalls[0].command).toMatchObject({
      id: "cmd-json-1",
      projectId: "p1",
      partition: "project:p1:story",
      type: "scene.create",
      payload: { sceneId: "s1" },
      actor: { clientId: "c2" },
      clientTs: 1,
    });

    expect(Object.keys(committedCalls[0].committedEvent)).toEqual(
      expect.arrayContaining(["committedId", "projectId", "type", "payload"]),
    );
    expect(committedCalls[0].committedEvent).toMatchObject({
      committedId: 1,
      committed_id: 1,
      projectId: "p1",
      partition: "project:p1:story",
      type: "scene.create",
      schemaVersion: 1,
      payload: { sceneId: "s1" },
      serverTs: 1,
      status_updated_at: 1,
    });
  });

  it("submits a single command through the batch API with command id as submit id", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport,
      store,
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    const commandIds = await session.submitCommands([
      {
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
        schemaVersion: 1,
        partition: "project:p1:story",
      },
    ]);

    expect(commandIds).toEqual(["cmd-local-1"]);
    const submit = transport.sent.find((entry) => entry.type === "submit_events");
    expect(submit).toBeTruthy();
    expect(submit.payload.events[0]).toMatchObject({
      id: "cmd-local-1",
      clientId: "c1",
      partitions: ["p1", "project:p1:story"],
      event: {
        type: "event",
        payload: {
          schema: "scene.create",
          schemaVersion: 1,
          data: { sceneId: "s1" },
        },
      },
    });
  });

  it("submits multiple commands in one ordered batch", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport,
      store,
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    const submittedIds = await session.submitCommands([
      {
        id: "cmd-batch-1",
        type: "scene.create",
        payload: { sceneId: "s1" },
        actor: { userId: "u1", clientId: "c1" },
        projectId: "p1",
        clientTs: 5,
        schemaVersion: 1,
        partition: "project:p1:story",
      },
      {
        id: "cmd-batch-2",
        type: "scene.rename",
        payload: { sceneId: "s1", title: "Intro" },
        actor: { userId: "u1", clientId: "c1" },
        projectId: "p1",
        clientTs: 6,
        schemaVersion: 1,
        partition: "project:p1:story",
      },
    ]);

    expect(submittedIds).toEqual(["cmd-batch-1", "cmd-batch-2"]);
    const submit = transport.sent.find((entry) => entry.type === "submit_events");
    expect(submit).toBeTruthy();
    expect(submit.payload.events.map((event) => event.id)).toEqual([
      "cmd-batch-1",
      "cmd-batch-2",
    ]);
  });

  it("proxies submitEvents through to the underlying sync client", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport,
      store,
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    const submittedIds = await session.submitEvents([
      {
        id: "evt-wrapper-1",
        partition: "project:p1:story",
        projectId: "p1",
        userId: "u1",
        type: "scene.create",
        schemaVersion: 1,
        payload: { sceneId: "s3" },
        meta: { clientId: "c1", clientTs: 7 },
      },
    ]);

    expect(submittedIds).toEqual(["evt-wrapper-1"]);
    const submit = transport.sent.find((entry) => entry.type === "submit_events");
    expect(submit.payload.events[0]).toMatchObject({
      id: "evt-wrapper-1",
      clientId: "c1",
      partitions: ["p1", "project:p1:story"],
      event: {
        type: "event",
        payload: {
          schema: "scene.create",
          schemaVersion: 1,
          data: { sceneId: "s3" },
        },
      },
    });
  });

  it("captures async onCommittedCommand failures", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport,
      store,
      onCommittedCommand: () => Promise.reject(new Error("commit handler boom")),
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();

    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [
          {
            id: "cmd-async-error",
            projectId: "p1",
            userId: "u2",
            partition: "project:p1:story",
            committedId: 1,
            type: "scene.create",
            schemaVersion: 1,
            payload: { sceneId: "s1" },
            meta: { clientId: "c2", clientTs: 1 },
            serverTs: 1,
          },
        ],
        nextSinceCommittedId: 1,
        hasMore: false,
      },
    });
    await tick();
    await tick();

    expect(session.getLastError()).toMatchObject({
      code: "on_committed_command_failed",
      message: "commit handler boom",
    });
  });

  it("rejects online transport swap when the transport does not support it", async () => {
    const transportWithoutSwap = createMockTransport();
    delete transportWithoutSwap.setOnlineTransport;

    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
      transport: transportWithoutSwap,
      store,
    });

    await expect(session.setOnlineTransport({ transportId: "next" })).rejects.toThrow(
      "Current transport does not support online transport swap",
    );
  });

  it("exposes session helpers and clears local lastError state", async () => {
    const forwardedEvents = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: {
        userId: "u1",
        clientId: "c1",
      },
      projectId: "p1",
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
      activeProjectId: "p1",
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
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
      partition: "project:p1:story",
      projectId: "p1",
      userId: "u1",
      type: "scene.create",
      schemaVersion: 1,
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

  it("validates session and command inputs before submitting", async () => {
    expect(() =>
      createCommandSyncSession({
        token: "t1",
        actor: { userId: "", clientId: "c1" },
        projectId: "p1",
        transport,
        store,
      }),
    ).toThrow("actor.userId and actor.clientId are required");

    expect(() =>
      createCommandSyncSession({
        token: "t1",
        actor: { userId: "u1", clientId: "c1" },
        projectId: "",
        transport,
        store,
      }),
    ).toThrow("projectId is required");

    const session = createCommandSyncSession({
      token: "t1",
      actor: { userId: "u1", clientId: "c1" },
      projectId: "p1",
      transport,
      store,
    });

    await expect(session.submitCommands([])).rejects.toThrow(
      "submitCommands requires at least one command",
    );
    await expect(
      session.submitCommands([{ id: "cmd-no-partition", type: "x" }]),
    ).rejects.toThrow("Command must include a partition");
  });

  it("swallows transport disconnects during command submit when configured", async () => {
    const session = createCommandSyncSession({
      token: "t1",
      actor: { userId: "u1", clientId: "c1" },
      projectId: "p1",
      transport,
      store,
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    transport.send.mockImplementation(async (message) => {
      if (message.type === "submit_events") {
        const error = new Error("websocket is not connected");
        error.code = "transport_disconnected";
        throw error;
      }
      transport.sent.push(message);
    });

    await expect(
      session.submitCommands([
        {
          id: "cmd-disconnect",
          partition: "project:p1:story",
          type: "scene.create",
          payload: {},
        },
      ]),
    ).resolves.toEqual(["cmd-disconnect"]);
    expect(session.getLastError()).toMatchObject({
      code: "transport_disconnected",
    });
  });

  it("tracks rejected and not_processed command outcomes from the server", async () => {
    const forwardedEvents = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: { userId: "u1", clientId: "c1" },
      projectId: "p1",
      transport,
      store,
      onEvent: (entry) => forwardedEvents.push(entry),
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
      },
    });
    await tick();

    await session.submitCommands([
      {
        id: "cmd-rejected",
        partition: "project:p1:story",
        type: "scene.create",
        payload: {},
      },
      {
        id: "cmd-not-processed",
        partition: "project:p1:story",
        type: "scene.rename",
        payload: {},
      },
    ]);

    transport.emit({
      type: "submit_events_result",
      payload: {
        results: [
          {
            id: "cmd-rejected",
            status: "rejected",
            reason: "validation_failed",
          },
          {
            id: "cmd-not-processed",
            status: "not_processed",
            reason: "prior_item_failed",
            blockedById: "cmd-rejected",
          },
        ],
      },
    });
    await tick();

    expect(forwardedEvents.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["rejected", "not_processed"]),
    );
    expect(session.getLastError()).toMatchObject({
      code: "prior_item_failed",
      payload: expect.objectContaining({
        id: "cmd-not-processed",
      }),
    });
  });

  it("dedupes committed command callbacks and ignores unmapped events", async () => {
    const committedCalls = [];
    const session = createCommandSyncSession({
      token: "t1",
      actor: { userId: "u1", clientId: "c1" },
      projectId: "p1",
      transport,
      store,
      mapCommittedToCommand: (event) => {
        if (event.id === "ignored") return null;
        return {
          id: event.id,
          partition: event.partition,
          type: event.type,
          payload: event.payload,
          actor: { userId: "u2", clientId: event.meta?.clientId },
        };
      },
      onCommittedCommand: (payload) => committedCalls.push(payload),
    });

    await session.start();
    transport.emit({
      type: "connected",
      payload: { clientId: "c1", projectId: "p1", projectLastCommittedId: 0 },
    });
    await tick();

    const committedEvent = {
      id: "cmd-dedupe",
      projectId: "p1",
      userId: "u2",
      partition: "project:p1:story",
      committedId: 1,
      type: "scene.create",
      schemaVersion: 1,
      payload: { sceneId: "s1" },
      meta: { clientId: "c2", clientTs: 1 },
      serverTs: 1,
    };
    transport.emit({
      type: "sync_response",
      payload: {
        projectId: "p1",
        events: [
          { ...committedEvent, id: "ignored" },
          committedEvent,
          structuredClone(committedEvent),
        ],
        nextSinceCommittedId: 1,
        hasMore: false,
      },
    });
    await tick();

    expect(committedCalls).toHaveLength(1);
    expect(committedCalls[0]).toMatchObject({
      sourceType: "sync_page",
      isFromCurrentActor: false,
      command: { id: "cmd-dedupe" },
    });
  });
});
