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

describe("regression: protocol version check", () => {
  it("rejects connect with unsupported protocol version", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "0.9",
      msgId: "old-version",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "old-version",
      payload: { code: "protocolVersion_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });

  it("rejects sync with unsupported protocol version after handshake", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocolVersion: "2.0",
      msgId: "bad-proto-sync",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "bad-proto-sync",
      payload: { code: "protocolVersion_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });

  it("accepts protocol version 1.0", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "good-version",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    expect(c1.sent[0].type).toBe("connected");
    expect(c1.closed).toBe(false);
  });

  it("rejects missing protocol version", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      msgId: "no-version",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "no-version",
      payload: { code: "protocolVersion_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });
});
