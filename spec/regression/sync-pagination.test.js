import { describe, expect, it } from "vitest";
import {
  createInMemorySyncStore,
  createSyncServer,
} from "../../src/index.js";

const createConnectionTransport = (connectionId) => {
  const sent = [];
  let closed = false;
  return {
    connectionId,
    sent,
    get closed() {
      return closed;
    },
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {
      closed = true;
    },
  };
};

const createServer = ({
  authorize = async () => true,
  now = () => 1000,
} = {}) => {
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: {
      verifyToken: async () => ({ clientId: "C1", claims: {} }),
    },
    authz: { authorizeProject: authorize },
    validation: { validate: async () => {} },
    store,
    clock: { now },
  });
  return { server, store };
};

const connectSession = async ({
  session,
  clientId = "C1",
  token = "jwt",
  projectId = "proj-1",
}) => {
  await session.receive({
    type: "connect",
    protocolVersion: "1.0",
    payload: { token, clientId, projectId },
  });
};

describe("regression: sync pagination", () => {
  it("pages through committed events correctly", async () => {
    const { server, store } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    for (let i = 1; i <= 5; i++) {
      await s1.receive({
        type: "submit_events",
        protocolVersion: "1.0",
        payload: {
          events: [
            {
              id: `evt-${i}`,
              partition: "P1",
              projectId: "proj-1",
              type: "x",
              schemaVersion: 1,
              payload: { n: i },
              meta: { clientId: "C1", clientTs: i },
            },
          ],
        },
      });
    }

    const page1 = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 2,
    });

    expect(page1.events.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextSinceCommittedId).toBe(2);

    const page2 = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: page1.nextSinceCommittedId,
      limit: 2,
    });

    expect(page2.events.map((e) => e.id)).toEqual(["evt-3", "evt-4"]);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextSinceCommittedId).toBe(4);

    const page3 = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: page2.nextSinceCommittedId,
      limit: 2,
    });

    expect(page3.events.map((e) => e.id)).toEqual(["evt-5"]);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextSinceCommittedId).toBe(5);
  });

  it("returns empty page when no events exist", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "empty-sync",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 100 },
    });

    const syncResponse = c1.sent.find((m) => m.type === "sync_response");
    expect(syncResponse.payload.events).toEqual([]);
    expect(syncResponse.payload.hasMore).toBe(false);
    expect(syncResponse.payload.nextSinceCommittedId).toBe(0);
  });

  it("respects syncToCommittedId upper bound", async () => {
    const { server, store } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    for (let i = 1; i <= 5; i++) {
      await store.commitOrGetExisting({
        id: `evt-${i}`,
        partition: "P1",
        projectId: "proj-1",
        type: "x",
        schemaVersion: 1,
        payload: { n: i },
        meta: { clientId: "C1", clientTs: i },
        now: 100 + i,
      });
    }

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
      syncToCommittedId: 3,
    });

    expect(page.events.map((e) => e.id)).toEqual(["evt-1", "evt-2", "evt-3"]);
    expect(page.hasMore).toBe(false);
  });

  it("filters events by project correctly", async () => {
    const { store } = createServer();

    await store.commitOrGetExisting({
      id: "evt-p1-1",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: {},
      meta: { clientId: "C1", clientTs: 1 },
      now: 100,
    });
    await store.commitOrGetExisting({
      id: "evt-p2-1",
      partition: "P1",
      projectId: "proj-2",
      type: "x",
      schemaVersion: 1,
      payload: {},
      meta: { clientId: "C1", clientTs: 2 },
      now: 200,
    });
    await store.commitOrGetExisting({
      id: "evt-p1-2",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: {},
      meta: { clientId: "C1", clientTs: 3 },
      now: 300,
    });

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });

    expect(page.events.map((e) => e.id)).toEqual(["evt-p1-1", "evt-p1-2"]);
  });

  it("handles sync with sinceCommittedId pointing to middle of events", async () => {
    const { store } = createServer();

    for (let i = 1; i <= 5; i++) {
      await store.commitOrGetExisting({
        id: `evt-${i}`,
        partition: "P1",
        projectId: "proj-1",
        type: "x",
        schemaVersion: 1,
        payload: { n: i },
        meta: { clientId: "C1", clientTs: i },
        now: 100 + i,
      });
    }

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 2,
      limit: 10,
    });

    expect(page.events.map((e) => e.id)).toEqual(["evt-3", "evt-4", "evt-5"]);
  });

  it("paginates partition-filtered sync without leaking unrelated partitions", async () => {
    const { server, store } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    for (const [id, partition] of [
      ["evt-p1-1", "P1"],
      ["evt-p1-2", "P1"],
      ["evt-p2-1", "P2"],
      ["evt-p2-2", "P2"],
    ]) {
      await store.commitOrGetExisting({
        id,
        partition,
        projectId: "proj-1",
        type: "x",
        schemaVersion: 1,
        payload: { partition },
        meta: { clientId: "C0", clientTs: 1 },
        now: 100,
      });
    }

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "sync-p2-page-1",
      payload: {
        projectId: "proj-1",
        partitions: ["P2"],
        sinceCommittedId: 0,
        limit: 2,
      },
    });

    const page1 = c1.sent.find((m) => m.msgId === "sync-p2-page-1");
    expect(page1.payload.events).toEqual([]);
    expect(page1.payload.hasMore).toBe(true);
    expect(page1.payload.nextSinceCommittedId).toBe(2);

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "sync-p2-page-2",
      payload: {
        projectId: "proj-1",
        partitions: ["P2"],
        sinceCommittedId: page1.payload.nextSinceCommittedId,
        limit: 2,
      },
    });

    const page2 = c1.sent.find((m) => m.msgId === "sync-p2-page-2");
    expect(page2.payload.events.map((e) => e.id)).toEqual([
      "evt-p2-1",
      "evt-p2-2",
    ]);
    expect(page2.payload.hasMore).toBe(false);
    expect(page2.payload.nextSinceCommittedId).toBe(4);
  });
});
