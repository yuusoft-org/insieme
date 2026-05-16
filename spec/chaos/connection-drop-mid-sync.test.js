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

describe("chaos: connection drop mid-sync", () => {
  it("does not affect other sessions when one connection closes mid-submit", async () => {
    const { server, store } = createServer({
      authorize: async () => true,
    });

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1 });
    await connectSession({
      session: s2,
      clientId: "C1",
      token: "jwt",
    });

    await s2.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s1.close("client_drop");

    expect(c1.closed).toBe(true);
    expect(c2.closed).toBe(false);

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

    const result = c2.sent.find((m) => m.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0].status).toBe("committed");
  });

  it("server shutdown closes all active sessions", async () => {
    const { server } = createServer();

    const connections = [];
    for (let i = 0; i < 5; i++) {
      const c = createConnectionTransport(`c-${i}`);
      connections.push(c);
      const s = server.attachConnection(c);
      await connectSession({ session: s });
    }

    await server.shutdown();

    for (const c of connections) {
      expect(c.closed).toBe(true);
    }
  });

  it("dropped session does not receive broadcasts after close", async () => {
    const { server } = createServer();

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1 });
    await connectSession({
      session: s2,
      clientId: "C1",
      token: "jwt",
    });

    await s2.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });

    await s1.close("drop");

    const c1BroadcastsBefore = c1.sent.filter(
      (m) => m.type === "event_broadcast",
    ).length;

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

    const c1BroadcastsAfter = c1.sent.filter(
      (m) => m.type === "event_broadcast",
    ).length;
    expect(c1BroadcastsAfter).toBe(c1BroadcastsBefore);
  });
});
