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
  now = () => 1000,
  limits,
} = {}) => {
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: {
      verifyToken: async () => ({ clientId: "C1", claims: {} }),
    },
    authz: { authorizeProject: authorize },
    validation: { validate },
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

describe("chaos: rate limit burst", () => {
  it("closes connection after exceeding message rate within window", async () => {
    let now = 10_000;
    const { server } = createServer({
      now: () => now,
      limits: {
        maxInboundMessagesPerWindow: 5,
        rateWindowMs: 1000,
        closeOnRateLimit: true,
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });
    // connect = 1 message, so we can send 4 more syncs before hitting limit (5 total)

    for (let i = 0; i < 4; i++) {
      await s1.receive({
        type: "sync",
        protocolVersion: "1.0",
        payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
      });
    }

    expect(c1.closed).toBe(false);

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "over-limit",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const lastMsg = c1.sent[c1.sent.length - 1];
    expect(lastMsg).toMatchObject({
      type: "error",
      msgId: "over-limit",
      payload: { code: "rate_limited" },
    });
    expect(c1.closed).toBe(true);
  });

  it("resets rate counter after window expires", async () => {
    let now = 10_000;
    const { server } = createServer({
      now: () => now,
      limits: {
        maxInboundMessagesPerWindow: 2,
        rateWindowMs: 1000,
        closeOnRateLimit: true,
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    now += 2000;

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    expect(c1.closed).toBe(false);

    const syncResponses = c1.sent.filter((m) => m.type === "sync_response");
    expect(syncResponses).toHaveLength(2);
  });

  it("rate limits per-connection independently", async () => {
    let now = 10_000;
    const { server } = createServer({
      now: () => now,
      limits: {
        maxInboundMessagesPerWindow: 3,
        rateWindowMs: 1000,
        closeOnRateLimit: true,
      },
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

    for (let i = 0; i < 4; i++) {
      await s1.receive({
        type: "sync",
        protocolVersion: "1.0",
        payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
      });
    }

    expect(c1.closed).toBe(true);

    await s2.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    expect(c2.closed).toBe(false);
    const c2Sync = c2.sent.filter((m) => m.type === "sync_response");
    expect(c2Sync).toHaveLength(1);
  });
});
