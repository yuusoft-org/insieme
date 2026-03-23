import { describe, expect, it } from "vitest";
import {
  createInMemorySyncStore,
  createSyncServer,
} from "../../../src/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

const syncSession = async ({ session, projectId = "proj-1", since = 0 }) => {
  await session.receive({
    type: "sync",
    protocolVersion: "1.0",
    payload: { projectId, sinceCommittedId: since, limit: 500 },
  });
};

const toSubmitItem = ({
  id,
  partition = "P1",
  event = { type: "x", payload: {} },
  schemaVersion = 1,
  projectId = "proj-1",
  userId,
  meta,
} = {}) => ({
  id,
  partition,
  projectId,
  userId,
  type: event.type,
  schemaVersion,
  payload: event.payload,
  meta: {
    clientId: "C1",
    clientTs: 1,
    ...meta,
  },
});

describe("src createSyncServer", () => {
  it("PT-SC-00 [SC-00]: handshake + empty sync", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    expect(c1.sent[0]).toMatchObject({
      type: "connected",
      payload: { clientId: "C1", projectId: "proj-1", projectLastCommittedId: 0 },
    });

    await syncSession({ session: s1 });
    expect(c1.sent[1]).toMatchObject({
      type: "sync_response",
      payload: {
        projectId: "proj-1",
        events: [],
        nextSinceCommittedId: 0,
        hasMore: false,
        syncToCommittedId: 0,
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
    await syncSession({ session: s1 });
    await syncSession({ session: s2 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-1",
            partition: "P1",
            event: { type: "x", payload: {} },
          }),
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
      committedId: 1,
    });

    const c1Broadcasts = c1.sent.filter((m) => m.type === "event_broadcast");
    const c2Broadcasts = c2.sent.filter((m) => m.type === "event_broadcast");
    expect(c1Broadcasts).toHaveLength(0);
    expect(c2Broadcasts).toHaveLength(1);
    expect(c2Broadcasts[0].payload).toMatchObject({
      id: "evt-1",
      committedId: 1,
      partition: "P1",
      projectId: "proj-1",
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
    await syncSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-bad-1",
            partition: "P1",
            event: { type: "x", payload: {} },
          }),
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

  it("commits ordered multi-item batches and broadcasts each committed item to peers", async () => {
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
    await syncSession({ session: s1 });
    await syncSession({ session: s2 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-batch-1",
            partition: "P1",
            event: { type: "x", payload: { n: 1 } },
          }),
          toSubmitItem({
            id: "evt-batch-2",
            partition: "P1",
            event: { type: "x", payload: { n: 2 } },
          }),
        ],
      },
    });

    const submitResult = c1.sent.find((message) => message.type === "submit_events_result");
    expect(submitResult).toBeTruthy();
    expect(submitResult.payload.results).toEqual([
      expect.objectContaining({
        id: "evt-batch-1",
        status: "committed",
        committedId: 1,
      }),
      expect.objectContaining({
        id: "evt-batch-2",
        status: "committed",
        committedId: 2,
      }),
    ]);

    const c1Broadcasts = c1.sent.filter((message) => message.type === "event_broadcast");
    const c2Broadcasts = c2.sent.filter((message) => message.type === "event_broadcast");
    expect(c1Broadcasts).toHaveLength(0);
    expect(c2Broadcasts).toHaveLength(2);
    expect(c2Broadcasts.map((message) => message.payload.id)).toEqual([
      "evt-batch-1",
      "evt-batch-2",
    ]);
  });

  it("stops batch processing on first failure and marks later items not_processed", async () => {
    const { server, store } = createServer({
      validate: async (item) => {
        if (item.type === "bad") {
          const error = new Error("invalid event");
          // @ts-ignore
          error.code = "validation_failed";
          throw error;
        }
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-ok-1",
            partition: "P1",
            event: { type: "x", payload: { n: 1 } },
          }),
          toSubmitItem({
            id: "evt-bad-2",
            partition: "P1",
            event: { type: "bad", payload: { n: 2 } },
          }),
          toSubmitItem({
            id: "evt-later-3",
            partition: "P1",
            event: { type: "x", payload: { n: 3 } },
          }),
        ],
      },
    });

    const submitResult = c1.sent.find((message) => message.type === "submit_events_result");
    expect(submitResult).toBeTruthy();
    expect(submitResult.payload.results).toEqual([
      expect.objectContaining({
        id: "evt-ok-1",
        status: "committed",
        committedId: 1,
      }),
      expect.objectContaining({
        id: "evt-bad-2",
        status: "rejected",
        reason: "validation_failed",
      }),
      expect.objectContaining({
        id: "evt-later-3",
        status: "not_processed",
        reason: "prior_item_failed",
        blockedById: "evt-bad-2",
      }),
    ]);

    const committedPage = await store.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });
    expect(committedPage.events.map((event) => event.id)).toEqual(["evt-ok-1"]);
  });

  it("accepts generic event objects and delegates domain semantics to app validation", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-invalid-1",
            partition: "P1",
            event: {
              type: "legacy.action",
              payload: {
                any: "value",
              },
            },
          }),
        ],
      },
    });

    const result = c1.sent.find((message) => message.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-invalid-1",
      status: "committed",
      committedId: 1,
    });
  });

  it("PT-SC-03 [SC-03]: duplicate retry returns existing commit", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    const submit = {
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-retry-1",
            partition: "P1",
            event: { type: "x", payload: { n: 1 } },
          }),
        ],
      },
    };

    await s1.receive(submit);
    await s1.receive(submit);

    const results = c1.sent.filter((m) => m.type === "submit_events_result");
    expect(results).toHaveLength(2);

    const firstCommittedId = results[0].payload.results[0].committedId;
    const secondCommittedId = results[1].payload.results[0].committedId;

    expect(firstCommittedId).toBe(1);
    expect(secondCommittedId).toBe(1);
  });

  it("rejects conflicting duplicate ids inside a single batch and blocks later items", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-dup-1",
            partition: "P1",
            event: { type: "x", payload: { n: 1 } },
          }),
          toSubmitItem({
            id: "evt-dup-1",
            partition: "P1",
            event: { type: "x", payload: { n: 2 } },
          }),
          toSubmitItem({
            id: "evt-after-2",
            partition: "P1",
            event: { type: "x", payload: { n: 3 } },
          }),
        ],
      },
    });

    const submitResult = c1.sent.find((message) => message.type === "submit_events_result");
    expect(submitResult).toBeTruthy();
    expect(submitResult.payload.results).toEqual([
      expect.objectContaining({
        id: "evt-dup-1",
        status: "committed",
        committedId: 1,
      }),
      expect.objectContaining({
        id: "evt-dup-1",
        status: "rejected",
        reason: "validation_failed",
      }),
      expect.objectContaining({
        id: "evt-after-2",
        status: "not_processed",
        reason: "prior_item_failed",
        blockedById: "evt-dup-1",
      }),
    ]);
  });

  it("uses project-scoped syncToCommittedId", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);

    await connectSession({ session: s1, clientId: "C1", token: "jwt" });
    await connectSession({ session: s2, clientId: "C1", token: "jwt" });
    await syncSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-p1-1",
            partition: "P1",
            event: { type: "legacy.action", payload: { n: 1 } },
          }),
        ],
      },
    });
    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-p2-1",
            partition: "P2",
            event: { type: "legacy.action", payload: { n: 2 } },
          }),
        ],
      },
    });
    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-p1-2",
            partition: "P1",
            event: { type: "legacy.action", payload: { n: 3 } },
          }),
        ],
      },
    });

    await syncSession({ session: s2, since: 0 });

    const syncResponse = c2.sent.find((message) => message.type === "sync_response");
    expect(syncResponse).toBeTruthy();
    expect(syncResponse.payload.events.map((event) => event.id)).toEqual([
      "evt-p1-1",
      "evt-p2-1",
      "evt-p1-2",
    ]);
    expect(syncResponse.payload.syncToCommittedId).toBe(3);
  });

  it("echoes request msgId on direct responses and errors", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "1.0",
      msgId: "msg-connect-1",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });
    expect(c1.sent[0]).toMatchObject({
      type: "connected",
      msgId: "msg-connect-1",
    });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "msg-sync-1",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 500 },
    });
    expect(c1.sent[1]).toMatchObject({
      type: "sync_response",
      msgId: "msg-sync-1",
    });

    await s1.receive({
      type: "unknown",
      protocolVersion: "1.0",
      msgId: "msg-err-1",
      payload: {},
    });
    expect(c1.sent[2]).toMatchObject({
      type: "error",
      msgId: "msg-err-1",
      payload: { code: "bad_request" },
    });
  });

  it("serializes concurrent submit batches per connection", async () => {
    let releaseFirstValidation;
    const firstValidationGate = new Promise((resolve) => {
      releaseFirstValidation = resolve;
    });
    const seenValidationIds = [];
    const { server } = createServer({
      validate: async (item) => {
        seenValidationIds.push(item.id);
        if (item.id === "evt-slow-1") {
          await firstValidationGate;
        }
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    const firstReceive = s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-slow-1",
            partition: "P1",
            event: { type: "x", payload: { n: 1 } },
          }),
        ],
      },
    });
    const secondReceive = s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          toSubmitItem({
            id: "evt-fast-2",
            partition: "P1",
            event: { type: "x", payload: { n: 2 } },
          }),
        ],
      },
    });

    await tick();
    expect(seenValidationIds).toEqual(["evt-slow-1"]);

    releaseFirstValidation();
    await Promise.all([firstReceive, secondReceive]);

    const submitResults = c1.sent.filter((message) => message.type === "submit_events_result");
    expect(submitResults).toHaveLength(2);
    expect(submitResults[0].payload.results[0]).toMatchObject({
      id: "evt-slow-1",
      status: "committed",
      committedId: 1,
    });
    expect(submitResults[1].payload.results[0]).toMatchObject({
      id: "evt-fast-2",
      status: "committed",
      committedId: 2,
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
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      msgId: "limit-msg",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 10 },
    });

    const last = c1.sent[c1.sent.length - 1];
    expect(last).toMatchObject({
      type: "error",
      msgId: "limit-msg",
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
      protocolVersion: "1.0",
      msgId: "too-big-1",
      payload: {
        token: "x".repeat(200),
        clientId: "C1",
        projectId: "proj-1",
      },
    });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      msgId: "too-big-1",
      payload: {
        code: "bad_request",
        details: {
          maxEnvelopeBytes: 64,
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
    await syncSession({ session: s1 });

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
      authz: { authorizeProject: async () => true },
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
        getMaxCommittedIdForProject: async () => 0,
        getMaxCommittedId: async () => 0,
      },
      clock: { now: () => 1000 },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: 99999 },
    });
    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0, limit: -5 },
    });
    await s1.receive({
      type: "sync",
      protocolVersion: "1.0",
      payload: { projectId: "proj-1", sinceCommittedId: 0 },
    });

    expect(seenLimits).toEqual([1000, 1, 500]);
  });
});
