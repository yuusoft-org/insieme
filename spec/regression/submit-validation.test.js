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

describe("regression: submit validation", () => {
  it("rejects event with missing type", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "",
            schemaVersion: 1,
            payload: {},
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("rejects event with missing partition", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: {},
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "bad_request",
    });
  });

  it("rejects event with invalid schemaVersion", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: -1,
            payload: {},
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("rejects event with missing payload", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "validation_failed",
    });
  });

  it("rejects event with mismatched clientId in meta", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: {},
            meta: { clientId: "C2", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "forbidden",
    });
  });

  it("rejects event with projectId not matching session project", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-2",
            type: "x",
            schemaVersion: 1,
            payload: {},
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "rejected",
      reason: "forbidden",
    });
  });

  it("rejects event with missing id", async () => {
    const { server } = createServer();
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      payload: {
        events: [
          {
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
      payload: { code: "bad_request" },
    });
  });
});
