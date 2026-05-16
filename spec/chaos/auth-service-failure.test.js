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

const createAuthFlakyServer = ({ failAfter, now = () => 1000 } = {}) => {
  let callCount = 0;
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: {
      verifyToken: async (token) => {
        callCount++;
        if (failAfter !== undefined && callCount > failAfter) {
          throw new Error("auth service unavailable");
        }
        return { clientId: token.split("-")[1] || "C1", claims: {} };
      },
    },
    authz: { authorizeProject: async () => true },
    validation: { validate: async () => {} },
    store,
    clock: { now },
  });
  return { server, store };
};

describe("chaos: auth service failure", () => {
  it("closes session gracefully when auth.verifyToken throws", async () => {
    const { server } = createAuthFlakyServer({ failAfter: 0 });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "connect-1",
      payload: { token: "jwt-C1", clientId: "C1", projectId: "proj-1" },
    });

    const errorMsg = c1.sent.find((m) => m.type === "error");
    expect(errorMsg).toMatchObject({
      type: "error",
      msgId: "connect-1",
      payload: { code: "auth_failed" },
    });
    expect(c1.closed).toBe(true);
  });

  it("does not leak sessions when auth fails", async () => {
    const { server } = createAuthFlakyServer({ failAfter: 0 });
    const transports = [];
    for (let i = 0; i < 5; i++) {
      const c = createConnectionTransport(`c-${i}`);
      transports.push(c);
      const s = server.attachConnection(c);
      await s.receive({
        type: "connect",
        protocolVersion: "1.0",
        payload: {
          token: "jwt-C1",
          clientId: "C1",
          projectId: "proj-1",
        },
      });
    }

    for (const c of transports) {
      expect(c.closed).toBe(true);
    }
  });

  it("allows reconnection after auth service recovers", async () => {
    let authShouldFail = true;
    const store = createInMemorySyncStore();
    const server = createSyncServer({
      auth: {
        verifyToken: async (token) => {
          if (authShouldFail) {
            throw new Error("auth down");
          }
          return { clientId: "C1", claims: {} };
        },
      },
      authz: { authorizeProject: async () => true },
      validation: { validate: async () => {} },
      store,
      clock: { now: () => 1000 },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });
    expect(c1.closed).toBe(true);

    authShouldFail = false;

    const c2 = createConnectionTransport("c2");
    const s2 = server.attachConnection(c2);
    await connectSession({ session: s2 });
    expect(c2.sent[0].type).toBe("connected");
  });
});
