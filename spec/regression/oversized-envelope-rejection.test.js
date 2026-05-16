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

describe("regression: oversized envelope rejection", () => {
  it("rejects oversized envelope and closes connection", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "oversize-1",
      payload: {
        token: "x".repeat(300 * 1024),
        clientId: "C1",
        projectId: "proj-1",
      },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "oversize-1",
      payload: {
        code: "bad_request",
        message: "Message exceeds maximum envelope size",
      },
    });
    expect(errorMsg.payload.details.maxEnvelopeBytes).toBeDefined();
    expect(c1.closed).toBe(true);
  });

  it("allows normal-sized messages through", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });

    expect(c1.sent[0].type).toBe("connected");
    expect(c1.closed).toBe(false);
  });

  it("does not close when closeOnOversize is false", async () => {
    const store = createInMemorySyncStore();
    const server = createSyncServer({
      auth: {
        verifyToken: async () => ({ clientId: "C1", claims: {} }),
      },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store,
      clock: { now: () => 1000 },
      limits: {
        maxEnvelopeBytes: 64,
        closeOnOversize: false,
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "oversize-noclose",
      payload: {
        token: "x".repeat(200),
        clientId: "C1",
        projectId: "proj-1",
      },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
    expect(c1.closed).toBe(false);
  });
});
