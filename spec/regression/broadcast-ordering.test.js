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

describe("regression: broadcast ordering", () => {
  it("broadcasts events in commit order to all peers", async () => {
    const { server } = createServer();

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1 });
    await connectSession({ session: s2 });

    await s2.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s1.receive({
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
          {
            id: "evt-2",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 2 },
            meta: { clientId: "C1", clientTs: 2 },
          },
          {
            id: "evt-3",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 3 },
            meta: { clientId: "C1", clientTs: 3 },
          },
        ],
      },
    });

    const broadcasts = c2.sent.filter((m) => m.type === "event_broadcast");
    expect(broadcasts).toHaveLength(3);
    expect(broadcasts[0].payload.committedId).toBe(1);
    expect(broadcasts[1].payload.committedId).toBe(2);
    expect(broadcasts[2].payload.committedId).toBe(3);
    expect(broadcasts.map((b) => b.payload.id)).toEqual([
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
  });

  it("does not broadcast to the submitting client", async () => {
    const { server } = createServer();

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s1.receive({
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

    const selfBroadcasts = c1.sent.filter(
      (m) => m.type === "event_broadcast",
    );
    expect(selfBroadcasts).toHaveLength(0);
  });

  it("broadcasts from multiple submitters are interleaved correctly", async () => {
    const { server, store } = createServer();

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const observer = createConnectionTransport("obs");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);
    const sObs = server.attachConnection(observer);
    await connectSession({ session: s1 });
    await connectSession({ session: s2 });
    await connectSession({ session: sObs });

    await sObs.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s1.receive({
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
            payload: { from: "c1" },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    await s2.receive({
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
            payload: { from: "c2" },
            meta: { clientId: "C1", clientTs: 2 },
          },
        ],
      },
    });

    const obsBroadcasts = observer.sent.filter(
      (m) => m.type === "event_broadcast",
    );
    expect(obsBroadcasts).toHaveLength(2);
    expect(obsBroadcasts[0].payload.id).toBe("evt-c1-1");
    expect(obsBroadcasts[1].payload.id).toBe("evt-c2-1");

    const page = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });
    expect(page.events.map((e) => e.id)).toEqual(["evt-c1-1", "evt-c2-1"]);
  });
});
