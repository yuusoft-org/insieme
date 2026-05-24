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

const createFlakyStore = () => {
  const realStore = createInMemorySyncStore();
  let shouldFail = false;
  let failCount = 0;
  let commitCallCount = 0;

  return {
    store: {
      commitOrGetExisting: async (input) => {
        commitCallCount++;
        if (shouldFail && failCount > 0) {
          failCount--;
          const err = new Error("transient store failure");
          err.code = "store_error";
          throw err;
        }
        return realStore.commitOrGetExisting(input);
      },
      listCommittedSince: (input) => realStore.listCommittedSince(input),
      getMaxCommittedIdForProject: (input) =>
        realStore.getMaxCommittedIdForProject(input),
      getMaxCommittedId: () => realStore.getMaxCommittedId(),
    },
    injectFailure: (count = 1) => {
      shouldFail = true;
      failCount = count;
    },
    heal: () => {
      shouldFail = false;
      failCount = 0;
    },
    get commitCallCount() {
      return commitCallCount;
    },
    getInnerStore: () => realStore,
  };
};

const createServer = ({ store, now = () => 1000 } = {}) => {
  const server = createSyncServer({
    auth: {
      verifyToken: async () => ({ clientId: "C1", claims: {} }),
    },
    authz: { authorizeProject: async () => true },
    validation: { validate: async () => {} },
    store,
    clock: { now },
  });
  return { server };
};

describe("chaos: store commit failure", () => {
  it("closes session with server_error when store throws unexpected error", async () => {
    const { store, injectFailure } = createFlakyStore();
    injectFailure(1);
    const { server } = createServer({ store });
    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);

    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "submit-1",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const errorMsg = c1.sent.find(
      (m) => m.type === "error" && m.payload.code === "server_error",
    );
    expect(errorMsg).toMatchObject({
      type: "error",
      msgId: "submit-1",
      payload: { code: "server_error" },
    });
    expect(c1.closed).toBe(true);
  });

  it("does not corrupt store state after a failed commit", async () => {
    const { store, injectFailure, heal, getInnerStore } = createFlakyStore();
    injectFailure(1);
    const { server } = createServer({ store });
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
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    heal();

    const innerStore = getInnerStore();
    const page = await innerStore.listCommittedSince({
      projectId: "proj-1",
      sinceCommittedId: 0,
      limit: 10,
    });
    expect(page.events).toHaveLength(0);
  });

  it("allows retry after store recovers from transient failure", async () => {
    const { store, injectFailure, heal } = createFlakyStore();
    const { server } = createServer({ store });

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

    injectFailure(1);

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "submit-fail",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    expect(c1.closed).toBe(true);

    heal();

    await s2.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "submit-ok",
      payload: {
        events: [
          {
            id: "evt-1",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 1 },
            meta: { clientId: "C1", clientTs: 1 },
          },
        ],
      },
    });

    const result = c2.sent.find((m) => m.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-1",
      status: "committed",
    });
  });

  it("bubbles store validation_failed errors as rejected items, not server errors", async () => {
    const realStore = createInMemorySyncStore();

    await realStore.commitOrGetExisting({
      id: "evt-1",
      partition: "P1",
      projectId: "proj-1",
      type: "x",
      schemaVersion: 1,
      payload: { n: 1 },
      meta: { clientId: "C1", clientTs: 1 },
      now: 100,
    });

    const { server } = createServer({
      store: {
        ...realStore,
        commitOrGetExisting: async () => {
          const err = new Error("same id submitted with different payload");
          err.code = "validation_failed";
          throw err;
        },
      },
    });

    const c1 = createConnectionTransport("c1");
    const s1 = server.attachConnection(c1);
    await connectSession({ session: s1 });

    await s1.receive({
      type: "submit_events",
      protocolVersion: "1.0",
      msgId: "submit-conflict",
      payload: {
        events: [
          {
            id: "evt-2",
            partition: "P1",
            projectId: "proj-1",
            type: "x",
            schemaVersion: 1,
            payload: { n: 2 },
            meta: { clientId: "C1", clientTs: 2 },
          },
        ],
      },
    });

    const result = c1.sent.find((m) => m.type === "submit_events_result");
    expect(result).toBeTruthy();
    expect(result.payload.results[0]).toMatchObject({
      id: "evt-2",
      status: "rejected",
      reason: "validation_failed",
    });
    expect(c1.closed).toBe(false);
  });
});
