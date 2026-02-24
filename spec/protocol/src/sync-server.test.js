import { describe, expect, it } from "vitest";
import {
  createInMemorySyncStore,
  createSyncServer,
} from "../../../src/index.js";

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
  validateSession,
  now = () => 1000,
  limits,
} = {}) => {
  const store = createInMemorySyncStore();
  const server = createSyncServer({
    auth: { verifyToken, validateSession },
    authz: { authorizePartitions: authorize },
    validation: { validate },
    store,
    clock: { now },
    limits,
  });

  return { server, store };
};

const connectSession = async ({ session, clientId = "C1", token = "jwt" }) => {
  await session.receive({
    type: "connect",
    protocol_version: "1.0",
    payload: { token, client_id: clientId },
  });
};

const syncSession = async ({ session, partitions = ["P1"], since = 0 }) => {
  await session.receive({
    type: "sync",
    protocol_version: "1.0",
    payload: { partitions, since_committed_id: since, limit: 500 },
  });
};

describe("src createSyncServer", () => {
  it("PT-SC-00 [SC-00]: handshake + empty sync", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    expect(c1.sent[0]).toMatchObject({
      type: "connected",
      payload: { client_id: "C1", server_last_committed_id: 0 },
    });

    await syncSession({ session: s1 });
    expect(c1.sent[1]).toMatchObject({
      type: "sync_response",
      payload: {
        partitions: ["P1"],
        events: [],
        next_since_committed_id: 0,
        has_more: false,
      },
    });
  });

  it("PT-SC-01 [SC-01][SC-10]: submit committed + peer broadcast only", async () => {
    const { server } = createServer({
      verifyToken: async (token) => ({
        clientId: token === "jwt-c2" ? "C2" : "C1",
        claims: {},
      }),
    });

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1, clientId: "C1", token: "jwt-c1" });
    await connectSession({ session: s2, clientId: "C2", token: "jwt-c2" });
    await syncSession({ session: s1, partitions: ["P1"] });
    await syncSession({ session: s2, partitions: ["P1"] });

    await s1.receive({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partitions: ["P1"],
            event: { type: "event", payload: { schema: "x", data: {} } },
          },
        ],
      },
    });

    const c1SubmitResult = c1.sent.find(
      (m) => m.type === "submit_events_result",
    );
    expect(c1SubmitResult).toBeTruthy();
    expect(c1SubmitResult.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "committed",
      committed_id: 1,
    });

    const c1Broadcasts = c1.sent.filter((m) => m.type === "event_broadcast");
    const c2Broadcasts = c2.sent.filter((m) => m.type === "event_broadcast");
    expect(c1Broadcasts).toHaveLength(0);
    expect(c2Broadcasts).toHaveLength(1);
    expect(c2Broadcasts[0].payload).toMatchObject({
      id: "evt-1",
      committed_id: 1,
      partitions: ["P1"],
    });
  });

  it("PT-SC-02 [SC-02]: rejected submit on validation failure", async () => {
    const { server } = createServer({
      validate: async () => {
        const error = new Error("invalid event");
        // @ts-ignore
        error.code = "validation_failed";
        throw error;
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1, partitions: ["P1"] });

    await s1.receive({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [
          {
            id: "evt-bad-1",
            partitions: ["P1"],
            event: { type: "event", payload: { schema: "x", data: {} } },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-bad-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("rejects unsupported non-domain event types before app validation", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1, partitions: ["P1"] });

    await s1.receive({
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [
          {
            id: "evt-invalid-1",
            partitions: ["P1"],
            event: {
              type: "legacy.action",
              payload: {
                any: "value",
              },
            },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-invalid-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("PT-SC-03 [SC-03]: duplicate retry returns existing commit", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1, partitions: ["P1"] });

    const submit = {
      type: "submit_events",
      protocol_version: "1.0",
      payload: {
        events: [
          {
            id: "evt-retry-1",
            partitions: ["P1"],
            event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          },
        ],
      },
    };

    await s1.receive(submit);
    await s1.receive(submit);

    const results = c1.sent.filter((m) => m.type === "submit_events_result");
    expect(results).toHaveLength(2);

    const firstCommittedId = results[0].payload.results[0].committed_id;
    const secondCommittedId = results[1].payload.results[0].committed_id;

    expect(firstCommittedId).toBe(1);
    expect(secondCommittedId).toBe(1);
  });

  it("echoes request msg_id on direct responses and errors", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocol_version: "1.0",
      msg_id: "msg-connect-1",
      payload: { token: "jwt", client_id: "C1" },
    });
    expect(c1.sent[0]).toMatchObject({
      type: "connected",
      msg_id: "msg-connect-1",
    });

    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      msg_id: "msg-sync-1",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: 500 },
    });
    expect(c1.sent[1]).toMatchObject({
      type: "sync_response",
      msg_id: "msg-sync-1",
    });

    await s1.receive({
      type: "unknown",
      protocol_version: "1.0",
      msg_id: "msg-err-1",
      payload: {},
    });
    expect(c1.sent[2]).toMatchObject({
      type: "error",
      msg_id: "msg-err-1",
      payload: { code: "bad_request" },
    });
  });

  it("enforces per-connection inbound rate limit and closes session", async () => {
    let now = 10_000;
    const { server } = createServer({
      now: () => now,
      limits: {
        maxInboundMessagesPerWindow: 2,
        rateWindowMs: 1000,
      },
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: 10 },
    });

    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      msg_id: "limit-msg",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: 10 },
    });

    const last = c1.sent[c1.sent.length - 1];
    expect(last).toMatchObject({
      type: "error",
      msg_id: "limit-msg",
      payload: { code: "rate_limited" },
    });
    expect(c1.closed).toBe(true);
  });

  it("rejects oversized envelopes with bad_request", async () => {
    const { server } = createServer({
      limits: {
        maxEnvelopeBytes: 64,
      },
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocol_version: "1.0",
      msg_id: "too-big-1",
      payload: {
        token: "x".repeat(200),
        client_id: "C1",
      },
    });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      msg_id: "too-big-1",
      payload: {
        code: "bad_request",
        details: {
          max_envelope_bytes: 64,
        },
      },
    });
    expect(c1.closed).toBe(true);
  });

  it("auth-fails and closes when session becomes invalid mid-connection", async () => {
    let active = true;
    const { server } = createServer({
      validateSession: async () => active,
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    expect(c1.sent[0].type).toBe("connected");

    active = false;
    await syncSession({ session: s1, partitions: ["P1"] });

    const last = c1.sent[c1.sent.length - 1];
    expect(last).toMatchObject({
      type: "error",
      payload: {
        code: "auth_failed",
      },
    });
    expect(c1.closed).toBe(true);
  });

  it("clamps sync.limit to protocol default/min/max bounds", async () => {
    const seenLimits = [];
    const server = createSyncServer({
      auth: { verifyToken: async () => ({ clientId: "C1", claims: {} }) },
      authz: { authorizePartitions: async () => true },
      validation: { validate: async () => {} },
      store: {
        commitOrGetExisting: async () => {
          throw new Error("not used");
        },
        listCommittedSince: async ({ limit, sinceCommittedId }) => {
          seenLimits.push(limit);
          return {
            events: [],
            hasMore: false,
            nextSinceCommittedId: sinceCommittedId,
          };
        },
        getMaxCommittedId: async () => 0,
      },
      clock: { now: () => 1000 },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: 99999 },
    });
    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      payload: { partitions: ["P1"], since_committed_id: 0, limit: -5 },
    });
    await s1.receive({
      type: "sync",
      protocol_version: "1.0",
      payload: { partitions: ["P1"], since_committed_id: 0 },
    });

    expect(seenLimits).toEqual([1000, 1, 500]);
  });
});
