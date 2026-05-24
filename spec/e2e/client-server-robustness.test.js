import { describe, expect, it } from "vitest";
import {
  createInMemoryClientStore,
  createSyncClient,
} from "../../src/index.js";
import { createTestServer } from "../harness/create-test-server.js";
import { createLoopbackTransport } from "../harness/create-loopback-transport.js";
import { tickN } from "../harness/event-helpers.js";

const createDroppingServerToClientTransport = ({
  server,
  connectionId,
  shouldDrop,
}) => {
  let onMessageHandler = null;
  let session = null;
  let connected = false;
  const sentMessages = [];
  const receivedMessages = [];
  const droppedMessages = [];

  const serverTransport = {
    connectionId,
    send: async (message) => {
      if (shouldDrop(message, droppedMessages)) {
        droppedMessages.push(message);
        return;
      }
      receivedMessages.push(message);
      if (onMessageHandler) onMessageHandler(message);
    },
    close: async () => {
      connected = false;
    },
  };

  return {
    connect: async () => {
      if (connected) return;
      session = server.attachConnection(serverTransport);
      connected = true;
    },
    disconnect: async () => {
      if (!connected || !session) return;
      try {
        await session.close("client_disconnect");
      } catch {
        // best effort in test transport
      }
      connected = false;
      session = null;
    },
    send: async (message) => {
      if (!connected || !session) {
        const error = new Error("transport disconnected");
        error.code = "transport_disconnected";
        throw error;
      }
      sentMessages.push(message);
      await session.receive(message);
    },
    onMessage: (handler) => {
      onMessageHandler = handler;
      return () => {
        if (onMessageHandler === handler) onMessageHandler = null;
      };
    },
    getSentMessages: () => [...sentMessages],
    getReceivedMessages: () => [...receivedMessages],
    getDroppedMessages: () => [...droppedMessages],
    isConnected: () => connected,
  };
};

const makeClient = ({
  server,
  store = createInMemoryClientStore(),
  clientId = "C1",
  projectId = "proj-1",
  transport,
  onEvent,
  uuid = () => "evt-e2e-1",
}) => {
  const runtimeTransport =
    transport ||
    createLoopbackTransport({
      server,
      connectionId: `conn-${clientId}-${Math.random()}`,
    });
  const client = createSyncClient({
    transport: runtimeTransport,
    store,
    token: clientId,
    clientId,
    projectId,
    now: (() => {
      let value = 10_000;
      return () => {
        value += 1;
        return value;
      };
    })(),
    uuid,
    onEvent,
    reconnect: { enabled: false },
  });
  return { client, store, transport: runtimeTransport };
};

describe("e2e client/server robustness", () => {
  it("recovers when a submit result is lost after the server durably commits", async () => {
    const { server, store: serverStore } = createTestServer();
    const clientStore = createInMemoryClientStore();
    const transport = createDroppingServerToClientTransport({
      server,
      connectionId: "conn-lost-result",
      shouldDrop: (message, dropped) =>
        message.type === "submit_events_result" && dropped.length === 0,
    });
    const { client } = makeClient({
      server,
      store: clientStore,
      transport,
      uuid: () => "evt-lost-result",
    });

    await client.start();
    await tickN(2);

    await client.submitEvent({
      partition: "docs",
      type: "doc.updated",
      schemaVersion: 1,
      payload: { title: "Draft committed without reply" },
    });
    await tickN(2);

    expect(transport.getDroppedMessages()).toHaveLength(1);
    expect(serverStore._debug.getCommitted().map((event) => event.id)).toEqual([
      "evt-lost-result",
    ]);
    expect(clientStore._debug.getDrafts().map((draft) => draft.id)).toEqual([
      "evt-lost-result",
    ]);

    await client.stop();

    const restarted = makeClient({
      server,
      store: clientStore,
      transport: createLoopbackTransport({
        server,
        connectionId: "conn-lost-result-restarted",
      }),
      uuid: () => "evt-unused",
    });
    await restarted.client.start();
    await tickN(3);

    expect(clientStore._debug.getDrafts()).toEqual([]);
    expect(clientStore._debug.getCommitted().map((event) => event.id)).toEqual([
      "evt-lost-result",
    ]);

    await restarted.client.stop();
  });

  it("applies server validation rejection and retries not_processed drafts end to end", async () => {
    const observedEvents = [];
    const { server, store: serverStore } = createTestServer({
      validate: async (item) => {
        if (item.payload?.reject === true) {
          const error = new Error("domain rejected event");
          error.code = "validation_failed";
          throw error;
        }
      },
    });
    const { client, store } = makeClient({
      server,
      onEvent: (event) => observedEvents.push(event),
    });

    await client.start();
    await tickN(2);

    await client.submitEvents([
      {
        id: "evt-ok-before-reject",
        partition: "workflow",
        type: "step.accepted",
        schemaVersion: 1,
        payload: { ok: true },
      },
      {
        id: "evt-domain-reject",
        partition: "workflow",
        type: "step.rejected",
        schemaVersion: 1,
        payload: { reject: true },
      },
      {
        id: "evt-retry-after-reject",
        partition: "workflow",
        type: "step.accepted",
        schemaVersion: 1,
        payload: { retry: true },
      },
    ]);
    await tickN(3);

    expect(observedEvents.map((event) => event.type)).toContain("rejected");
    expect(observedEvents.map((event) => event.type)).toContain("not_processed");

    expect(serverStore._debug.getCommitted().map((event) => event.id)).toEqual([
      "evt-ok-before-reject",
      "evt-retry-after-reject",
    ]);
    expect(store._debug.getCommitted().map((event) => event.id)).toEqual([
      "evt-ok-before-reject",
      "evt-retry-after-reject",
    ]);
    expect(store._debug.getDrafts()).toEqual([]);

    await client.stop();
  });

  it("auto-pages a large server backlog before flushing local drafts", async () => {
    const { server, store: serverStore, now } = createTestServer();
    for (let index = 1; index <= 501; index += 1) {
      await serverStore.commitOrGetExisting({
        id: `evt-backlog-${index}`,
        partition: "history",
        projectId: "proj-1",
        type: "history.appended",
        schemaVersion: 1,
        payload: { index },
        meta: { clientId: "seed", clientTs: index },
        now: now(),
      });
    }

    const { client, store, transport } = makeClient({
      server,
      uuid: () => "evt-after-backlog",
    });
    await store.insertDraft({
      id: "evt-after-backlog",
      partition: "history",
      type: "history.local",
      schemaVersion: 1,
      payload: { local: true },
      meta: { clientId: "C1", clientTs: 50_000 },
      createdAt: 50_000,
    });

    await client.start();
    await tickN(8);

    const syncRequests = transport
      .getSentMessages()
      .filter((message) => message.type === "sync");
    expect(syncRequests.map((message) => message.payload.sinceCommittedId)).toEqual([
      0,
      500,
    ]);
    expect(await store.loadCursor()).toBe(501);
    expect(store._debug.getCommitted()).toHaveLength(502);
    expect(store._debug.getDrafts()).toEqual([]);
    expect(serverStore._debug.getCommitted().at(-1).id).toBe(
      "evt-after-backlog",
    );

    await client.stop();
  });
});
