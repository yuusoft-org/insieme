import { describe, expect, it } from "vitest";
import {
  createInMemorySyncStore,
  createSyncServer,
} from "../../../src-next/index.js";

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
    authz: { authorizePartitions: authorize },
    validation: { validate },
    store: resolvedStore,
    clock: { now: () => 1000 },
  });

  return { server, store: resolvedStore };
};

const connectSession = async ({ session, clientId = "C1", token = "jwt" }) => {
  await session.receive({
    type: "connect",
    protocol_version: "1.0",
    payload: { token, client_id: clientId },
  });
};

const syncSession = async ({
  session,
  partitions = ["P1"],
  since = 0,
  limit = 500,
}) => {
  await session.receive({
    type: "sync",
    protocol_version: "1.0",
    payload: { partitions, since_committed_id: since, limit },
  });
};

const submitSession = async ({
  session,
  id,
  partitions = ["P1"],
  event = { type: "event", payload: { schema: "x", data: {} } },
}) => {
  await session.receive({
    type: "submit_events",
    protocol_version: "1.0",
    payload: {
      events: [
        {
          id,
          partitions,
          event,
        },
      ],
    },
  });
};

describe("src-next createSyncServer conformance", () => {
  it("rejects non-connect messages before handshake", async () => {
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

  it("rejects unsupported protocol_version and closes", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await s1.receive({
      type: "connect",
      protocol_version: "9.9",
      payload: { token: "jwt", client_id: "C1" },
    });

    expect(c1.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "protocol_version_unsupported" },
    });
    expect(c1.closed).toBe(true);
  });

  it("closes when authentication fails", async () => {
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

  it("closes when authenticated client identity mismatches connect client_id", async () => {
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

  it("rejects unauthorized sync with forbidden and keeps session open", async () => {
    const { server } = createServer({
      authorize: async (_identity, partitions) => partitions[0] !== "P-DENIED",
    });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1, partitions: ["P-DENIED"] });

    const forbidden = c1.sent.find(
      (message) =>
        message.type === "error" && message.payload.code === "forbidden",
    );
    expect(forbidden).toBeTruthy();
    expect(c1.closed).toBe(false);
  });

  it("rejects unauthorized submit as forbidden result", async () => {
    const { server } = createServer({ authorize: async () => false });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });
    await submitSession({ session: s1, id: "evt-1" });

    const result = c1.sent.find((message) => message.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "forbidden",
    });
  });

  it("rejects duplicate retry when same id has different canonical payload", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });
    await syncSession({ session: s1 });

    await submitSession({
      session: s1,
      id: "evt-1",
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await submitSession({
      session: s1,
      id: "evt-1",
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
    });

    const results = c1.sent.filter((message) => message.type === "submit_events_result");
    expect(results).toHaveLength(2);

    expect(results[0].payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "committed",
      committed_id: 1,
    });

    expect(results[1].payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("keeps sync cycle bounded and suppresses broadcasts until final page", async () => {
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
    await submitSession({ session: s1, id: "evt-1", partitions: ["P1"] });
    await submitSession({ session: s1, id: "evt-2", partitions: ["P1"] });

    await connectSession({ session: s2, clientId: "C2", token: "jwt-c2" });
    await syncSession({ session: s2, partitions: ["P1"], since: 0, limit: 1 });

    const firstSyncPage = c2.sent.find((message) =>
      message.type === "sync_response" && message.payload.next_since_committed_id === 1,
    );
    expect(firstSyncPage).toBeTruthy();
    expect(firstSyncPage.payload.events.map((event) => event.id)).toEqual(["evt-1"]);
    expect(firstSyncPage.payload.has_more).toBe(true);

    await submitSession({ session: s1, id: "evt-3", partitions: ["P1"] });

    const broadcastsDuringSync = c2.sent.filter(
      (message) => message.type === "event_broadcast",
    );
    expect(broadcastsDuringSync).toHaveLength(0);

    await syncSession({ session: s2, partitions: ["P1"], since: 1, limit: 1 });

    const syncResponses = c2.sent.filter((message) => message.type === "sync_response");
    expect(syncResponses).toHaveLength(2);
    expect(syncResponses[1].payload.events.map((event) => event.id)).toEqual(["evt-2"]);
    expect(syncResponses[1].payload.has_more).toBe(false);
    expect(syncResponses[1].payload.next_since_committed_id).toBe(2);

    await syncSession({ session: s2, partitions: ["P1"], since: 2, limit: 10 });

    const finalSync = c2.sent[c2.sent.length - 1];
    expect(finalSync).toMatchObject({
      type: "sync_response",
      payload: {
        next_since_committed_id: 3,
        has_more: false,
      },
    });
    expect(finalSync.payload.events.map((event) => event.id)).toEqual(["evt-3"]);
  });

  it("broadcasts only to sessions whose active partitions intersect", async () => {
    const { server } = createServer({
      verifyToken: async (token) => ({ clientId: token.toUpperCase(), claims: {} }),
    });

    const c1 = createConnectionTransport("c1");
    const c2 = createConnectionTransport("c2");
    const c3 = createConnectionTransport("c3");
    const s1 = server.attachConnection(c1);
    const s2 = server.attachConnection(c2);
    const s3 = server.attachConnection(c3);

    await connectSession({ session: s1, clientId: "JWT-C1", token: "jwt-c1" });
    await connectSession({ session: s2, clientId: "JWT-C2", token: "jwt-c2" });
    await connectSession({ session: s3, clientId: "JWT-C3", token: "jwt-c3" });

    await syncSession({ session: s2, partitions: ["P2"] });
    await syncSession({ session: s3, partitions: ["P3"] });

    await submitSession({
      session: s1,
      id: "evt-100",
      partitions: ["P1", "P2"],
    });

    const c2Broadcasts = c2.sent.filter((message) => message.type === "event_broadcast");
    const c3Broadcasts = c3.sent.filter((message) => message.type === "event_broadcast");

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
