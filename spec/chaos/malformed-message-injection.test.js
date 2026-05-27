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
  validate = async () => {},
  authorize = async () => true,
  verifyToken = async () => ({ clientId: "C1", claims: {} }),
  now = () => 1000,
} = {}) => {
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: { verifyToken },
    authz: { authorizeProject: authorize },
    validation: { validate },
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

describe("chaos: malformed message injection", () => {
  it("handles null message gracefully", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive(null);

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });

  it("handles non-object message (string) gracefully", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive("not an object");

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });

  it("handles message with missing type", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      protocolVersion: "1.0",
      payload: {},
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request", message: "Missing required envelope fields" },
    });
  });

  it("handles message with missing payload", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });

  it("handles unsupported protocol version by closing session", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "99.0",
      msgId: "bad-version",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "bad-version",
      payload: { code: "protocolVersion_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });

  it("handles empty events array in submit", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "empty-submit",
      payload: { events: [] },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "empty-submit",
      payload: {
        code: "bad_request",
        message: "payload.events must contain at least one item",
      },
    });
  });

  it("handles connect before handshake with correct error", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "premature-sync",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "premature-sync",
      payload: {
        code: "bad_request",
        message: "Only connect is allowed before handshake",
      },
    });
  });

  it("handles unknown message type gracefully after handshake", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "unknown_type",
      protocolVersion: "1.0",
      msgId: "unknown-1",
      payload: {},
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      msgId: "unknown-1",
      payload: {
        code: "bad_request",
        message: "Unknown message type: unknown_type",
      },
    });
  });

  it("handles array as message body", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive([1, 2, 3]);

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });

  it("handles numeric msgId gracefully", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: 42,
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      payload: { code: "bad_request" },
    });
  });
});
