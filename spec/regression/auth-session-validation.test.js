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

describe("regression: auth session validation", () => {
  it("rejects unauthenticated submit before handshake with bad_request", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "no-auth",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: {},
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request", message: "Only connect is allowed before handshake" },
    });
  });

  it("rejects unauthenticated sync", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "no-auth-sync",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });

  it("rejects connect with mismatched clientId", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "mismatch",
      payload: { token: "jwt", clientId: "C2", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "auth_failed" },
    });
    expect(c1.closed).toBe(true);
  });

  it("rejects connect when authorization denies project access", async () => {
    const { server } = createServer({
      authorize: async () => false,
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "forbidden",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "forbidden" },
    });
    expect(c1.closed).toBe(true);
  });

  it("expires session mid-connection when validateSession returns false", async () => {
    let active = true;
    const store = createInMemorySyncStore();
    const server = createSyncServer({
      auth: {
        verifyToken: async () => ({ clientId: "C1", claims: {} }),
        validateSession: async () => active,
      },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store,
      clock: { now: () => 1000 },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    const firstSync = await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "sync-ok",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });
    expect(c1.sent.find((m) => m.msgId === "sync-ok").type).toBe(
      "sync_response",
    );

    active = false;

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "sync-expired",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const errorMsg = c1.sent.find((m) => m.msgId === "sync-expired");
    expect(errorMsg).toMatchObject({
      type: "error",
      payload: { code: "auth_failed", message: "Session is no longer authorized" },
    });
    expect(c1.closed).toBe(true);
  });
});
