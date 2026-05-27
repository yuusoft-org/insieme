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
  limits,
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
    limits,
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

describe("chaos: concurrent session stress", () => {
  it("handles many concurrent connections and broadcasts correctly", async () => {
    const { server } = createServer();

    const NUM_CLIENTS = 10;
    const transports = [];
    const sessions = [];

    for (let i = 0; i < NUM_CLIENTS; i++) {
      const c = createConnectionTransport(`c-${i}`);
      transports.push(c);
      const s = server.attachConnection(c);
      sessions.push(s);
      await connectSession({ session: s });
    }

    for (const s of sessions) {
      await s.receive({
        type: "sync",
        protocolVersion: "1.0",
        payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
      });
    }

    await sessions[0].receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const submitterBroadcasts = transports[0].sent.filter(
      (m) => m.type === "event_broadcast",
    );
    expect(submitterBroadcasts).toHaveLength(0);

    for (let i = 1; i < NUM_CLIENTS; i++) {
      const broadcasts = transports[i].sent.filter(
        (m) => m.type === "event_broadcast",
      );
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload.id).toBe("evt-1");
    }
  });

  it("handles concurrent submits from different connections with ordered committedIds", async () => {
    const { server, store } = createServer();

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1 });
    await connectSession({ session: s2 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });
    await s2.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    const submit1 = s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-c1-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const submit2 = s2.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-c2-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 2 },
            meta: { clientId: "C1", clientTs: 2 },
          },
        ],
      },
    });

    await Promise.all([submit1, submit2]);

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });

    const ids = page.events.map((e) => e.id);
    expect(ids).toContain("evt-c1-1");
    expect(ids).toContain("evt-c2-1");
    expect(page.events).toHaveLength(2);

    const committedIds = page.events.map((e) => e.committedId);
    expect(new Set(committedIds).size).toBe(2);
  });

  it("does not broadcast to syncing sessions", async () => {
    const { server } = createServer();

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const c3 = createConnectionTransport("c3");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);
    const s3 = server.attachConnection(c3);

    await connectSession({ session: s1 });
    await connectSession({ session: s2 });
    await connectSession({ session: s3 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });
    await s3.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s2.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const c1Broadcasts = c1.sent.filter((m) => m.type === "event_broadcast");
    const c2Broadcasts = c2.sent.filter((m) => m.type === "event_broadcast");
    const c3Broadcasts = c3.sent.filter((m) => m.type === "event_broadcast");

    expect(c1Broadcasts).toHaveLength(1);
    expect(c2Broadcasts).toHaveLength(0);
    expect(c3Broadcasts).toHaveLength(1);
  });
});
