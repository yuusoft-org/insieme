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
  store,
} = {}) => {
  const resolvedStore = store || createInMemorySyncStore();
  const server = createSyncServer({
    auth: { verifyToken },
    authz: { authorizeProject: authorize },
    validation: { validate },
    store: resolvedStore,
    clock: { now: () => 1000 },
  });

  return { server, store: resolvedStore };
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

const syncSession = async ({
  session,
  projectId = "proj-1",
  since = 0,
  limit = 500,
}) => {
  await session.receive({
    type: "sync",
    protocolVersion: "1.0",
    payload: { projectId, sinceCommittedId: since, limit },
  });
};

const submitSession = async ({
  session,
  id,
  partition = "P1",
  clientId = "C1",
  type = "x",
  schemaVersion = 1,
  payload = {},
  meta,
  projectId = "proj-1",
}) => {
  await session.receive({
    type: "submit_events",
    protocolVersion: "1.0",
    payload: {
      events: [
        {
          id,
          partition,
          projectId,
          type,
          schemaVersion,
          payload,
          meta: meta ?? { clientId, clientTs: 1000 },
        },
      ],
    },
  });
};

describe("src createSyncServer conformance", () => {
  it("rejects non-connect messages before handshake [SC-18]", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await syncSession({ session: s1 });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "bad_request" },
    });
    expect(c1.closed).toBe(false);
  });

  it("rejects unsupported protocolVersion and closes [SC-18]", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocolVersion: "9.9",
      payload: { token: "jwt", clientId: "C1", projectId: "proj-1" },
    });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "protocolVersion_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });

  it("closes when authentication fails [SC-18]", async () => {
    const { server } = createServer({
      verifyToken: async () => {
        throw new Error("invalid token");
      },
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "auth_failed" },
    });
    expect(c1.closed).toBe(true);
  });

  it("closes when authenticated client identity mismatches connect clientId [SC-18]", async () => {
    const { server } = createServer({
      verifyToken: async () => ({ clientId: "C-OTHER", claims: {} }),
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1, clientId: "C1" });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "auth_failed" },
    });
    expect(c1.closed).toBe(true);
  });

  it("rejects sync for a mismatched project and keeps session open [SC-18]", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1, projectId: "proj-2" });

    const forbidden = c1.sent.find(
      (message) =>
        message.type === "error" && message.payload.code === "forbidden",
    );
    expect(forbidden).toBeTruthy();
    expect(c1.closed).toBe(false);
  });

  it("rejects unauthorized submit as forbidden result [SC-18]", async () => {
    let allowProject = true;
    const { server } = createServer({
      authorize: async () => allowProject,
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });
    allowProject = false;
    await submitSession({ session: s1, id: "evt-1" });

    const result = c1.sent.find(
      (message) => message.type === "submit_events_result",
    );
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "forbidden",
    });
  });

  it("rejects duplicate retry when same id has different canonical payload [SC-09]", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    await submitSession({
      session: s1,
      id: "evt-1",
      type: "x",
      payload: { n: 1 },
    });
    await submitSession({
      session: s1,
      id: "evt-1",
      type: "x",
      payload: { n: 2 },
    });

    const results = c1.sent.filter(
      (message) => message.type === "submit_events_result",
    );
    expect(results).toHaveLength(2);

    expect(results[0].payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "committed",
      committedId: 1,
    });

    expect(results[1].payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("keeps sync cycle bounded and suppresses broadcasts until final page [SC-05]", async () => {
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
    await submitSession({ session: s1, id: "evt-1", partition: "P1" });
    await submitSession({ session: s1, id: "evt-2", partition: "P1" });

    await connectSession({ session: s2, clientId: "C2", token: "jwt-c2" });
    await syncSession({ session: s2, since: 0, limit: 1 });

    const firstSyncPage = c2.sent.find(
      (message) =>
        message.type === "sync_response" &&
        message.payload.nextSinceCommittedId === 1,
    );
    expect(firstSyncPage).toBeTruthy();
    expect(firstSyncPage.payload.events.map((event) => event.id)).toEqual([
      "evt-1",
    ]);
    expect(firstSyncPage.payload.hasMore).toBe(true);

    await submitSession({ session: s1, id: "evt-3", partition: "P1" });

    const broadcastsDuringSync = c2.sent.filter(
      (message) => message.type === "event_broadcast",
    );
    expect(broadcastsDuringSync).toHaveLength(0);

    await syncSession({ session: s2, since: 1, limit: 1 });

    const syncResponses = c2.sent.filter(
      (message) => message.type === "sync_response",
    );
    expect(syncResponses).toHaveLength(2);
    expect(syncResponses[1].payload.events.map((event) => event.id)).toEqual([
      "evt-2",
    ]);
    expect(syncResponses[1].payload.hasMore).toBe(false);
    expect(syncResponses[1].payload.nextSinceCommittedId).toBe(2);

    await syncSession({ session: s2, since: 2, limit: 10 });

    const finalSync = c2.sent[c2.sent.length - 1];
    expect(finalSync).toMatchObject({
      type: "sync_response",
      payload: {
        nextSinceCommittedId: 3,
        hasMore: false,
      },
    });
    expect(finalSync.payload.events.map((event) => event.id)).toEqual([
      "evt-3",
    ]);
  });

  it("broadcasts only to sessions on the same active project [SC-04]", async () => {
    const { server } = createServer({
      verifyToken: async (token) => ({
        clientId: token.toUpperCase(),
        claims: {},
      }),
    });

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const c3 = createConnectionTransport("c3");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);
    const s3 = server.attachConnection(c3);

    await connectSession({ session: s1, clientId: "JWT-C1", token: "jwt-c1" });
    await connectSession({ session: s2, clientId: "JWT-C2", token: "jwt-c2" });
    await connectSession({
      session: s3,
      clientId: "JWT-C3",
      token: "jwt-c3",
      projectId: "proj-2",
    });

    await syncSession({ session: s2 });
    await syncSession({ session: s3, projectId: "proj-2" });

    await submitSession({
      session: s1,
      id: "evt-100",
      partition: "P2",
      clientId: "JWT-C1",
    });

    const c2Broadcasts = c2.sent.filter(
      (message) => message.type === "event_broadcast",
    );
    const c3Broadcasts = c3.sent.filter(
      (message) => message.type === "event_broadcast",
    );

    expect(c2Broadcasts).toHaveLength(1);
    expect(c2Broadcasts[0].payload.id).toBe("evt-100");
    expect(c3Broadcasts).toHaveLength(0);
  });

  it("sends server_error and closes on unexpected commit failures", async () => {
    const baseStore = createInMemorySyncStore();
    const { server } = createServer({
      store: {
        ...baseStore,
        commitOrGetExisting: async () => {
          throw new Error("db unavailable");
        },
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });
    await submitSession({ session: s1, id: "evt-crash" });

    const error = c1.sent.find((message) => message.type === "error");
    expect(error).toBeTruthy();
    expect(error.payload.code).toBe("server_error");
    expect(c1.closed).toBe(true);
  });
});
