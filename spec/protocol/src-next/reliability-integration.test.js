import { describe, expect, it } from "vitest";
import {
  createInMemoryClientStore,
  createInMemorySyncStore,
  createSyncClient,
  createSyncServer,
} from "../../../src-next/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const createNowFactory = (start = 1000) => {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
};

const createRng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const createUuidFactory = (prefix) => {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}-${i}`;
  };
};

const makeServer = ({
  store,
  now,
  logger = () => {},
  verifyToken = async (token) => ({ clientId: token, claims: {} }),
  authorize = async () => true,
  validate = async () => {},
}) =>
  createSyncServer({
    auth: { verifyToken },
    authz: { authorizePartitions: authorize },
    validation: { validate },
    store,
    clock: { now },
    logger,
  });

const createLoopbackTransport = ({ server, connectionId }) => {
  /** @type {null|((message: object) => void)} */
  let onMessage = null;
  /** @type {null|{ receive: (message: object) => Promise<void>, close: (reason?: string) => Promise<void> }} */
  let session = null;
  let connected = false;

  const serverTransport = {
    connectionId,
    send: async (message) => {
      if (onMessage) onMessage(message);
    },
    close: async () => {
      connected = false;
      session = null;
    },
  };

  return {
    connect: async () => {
      if (connected) return;
      session = server.attachConnection(serverTransport);
      connected = true;
    },
    disconnect: async () => {
      if (!connected || !session) return;
      await session.close("client_disconnect");
      connected = false;
      session = null;
    },
    send: async (message) => {
      if (!connected || !session) {
        throw new Error("transport disconnected");
      }
      await session.receive(message);
    },
    onMessage: (handler) => {
      onMessage = handler;
      return () => {
        if (onMessage === handler) onMessage = null;
      };
    },
    setServer: (nextServer) => {
      server = nextServer;
      connected = false;
      session = null;
    },
    isConnected: () => connected,
  };
};

const createClientNode = ({
  server,
  token,
  clientId,
  partitions = ["P1"],
  store,
  now,
  uuid,
  logger = () => {},
  validateLocalEvent,
}) => {
  const transport = createLoopbackTransport({
    server,
    connectionId: `conn-${clientId}`,
  });

  const client = createSyncClient({
    transport,
    store,
    token,
    clientId,
    partitions,
    now,
    uuid,
    logger,
    validateLocalEvent,
  });

  return {
    client,
    transport,
    store,
  };
};

const readCommittedIds = (store) =>
  store._debug
    .getCommitted()
    .map((entry) => entry.id)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

describe("src-next reliability integration", () => {
  it("SC-06: applies out-of-order committed arrivals deterministically", async () => {
    const store = createInMemoryClientStore();

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-130",
          client_id: "C2",
          partitions: ["P1"],
          committed_id: 130,
          event: { type: "event", payload: { schema: "x", data: { n: 130 } } },
          status_updated_at: 1300,
        },
      ],
    });

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-129",
          client_id: "C2",
          partitions: ["P1"],
          committed_id: 129,
          event: { type: "event", payload: { schema: "x", data: { n: 129 } } },
          status_updated_at: 1290,
        },
      ],
      nextCursor: 130,
    });

    const committed = store._debug.getCommitted();
    expect(committed.map((entry) => entry.committed_id)).toEqual([129, 130]);
    expect(await store.loadCursor()).toBe(130);
  });

  it("SC-07: partial-progress replay remains idempotent across restart boundaries", async () => {
    const store = createInMemoryClientStore();

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          status_updated_at: 1,
        },
      ],
    });

    // Simulate crash before cursor checkpoint persisted.
    expect(await store.loadCursor()).toBe(0);

    await store.applyCommittedBatch({
      events: [
        {
          id: "evt-1",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 1,
          event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
          status_updated_at: 1,
        },
        {
          id: "evt-2",
          client_id: "C1",
          partitions: ["P1"],
          committed_id: 2,
          event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
          status_updated_at: 2,
        },
      ],
      nextCursor: 2,
    });

    expect(store._debug.getCommitted().map((entry) => entry.id)).toEqual([
      "evt-1",
      "evt-2",
    ]);
    expect(await store.loadCursor()).toBe(2);
  });

  it("SC-08: local validation gate prevents invalid drafts from entering queue", async () => {
    const serverStore = createInMemorySyncStore();
    const server = makeServer({ store: serverStore, now: createNowFactory() });
    const store = createInMemoryClientStore();

    const node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store,
      now: createNowFactory(),
      uuid: createUuidFactory("evt"),
      validateLocalEvent: (item) => {
        if (!item.event?.payload?.data?.ok) {
          throw new Error("local validation failed");
        }
      },
    });

    await node.client.start();
    await tick();

    await expect(
      node.client.submitEvent({
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { ok: false } } },
      }),
    ).rejects.toThrow("local validation failed");

    expect(node.store._debug.getDrafts()).toHaveLength(0);

    await node.client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { ok: true } } },
    });
    await tick();

    const committed = node.store._debug.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0].id).toBe("evt-2");
  });

  it("SC-11: out-of-order submit results resolve drafts by id", async () => {
    const store = createInMemoryClientStore();

    await store.insertDraft({
      id: "evt-d1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 1,
    });
    await store.insertDraft({
      id: "evt-d2",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      createdAt: 2,
    });
    await store.insertDraft({
      id: "evt-d3",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      createdAt: 3,
    });

    await store.applySubmitResult({
      result: {
        id: "evt-d2",
        status: "committed",
        committed_id: 501,
        status_updated_at: 501,
      },
      fallbackClientId: "C1",
    });
    await store.applySubmitResult({
      result: {
        id: "evt-d1",
        status: "committed",
        committed_id: 502,
        status_updated_at: 502,
      },
      fallbackClientId: "C1",
    });
    await store.applySubmitResult({
      result: {
        id: "evt-d3",
        status: "committed",
        committed_id: 503,
        status_updated_at: 503,
      },
      fallbackClientId: "C1",
    });

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(
      store._debug.getCommitted().map((entry) => entry.committed_id),
    ).toEqual([501, 502, 503]);
  });

  it("SC-12: adding partitions mid-session with since=0 converges without duplicates", async () => {
    const serverStore = createInMemorySyncStore();
    const now = createNowFactory();

    await serverStore.commitOrGetExisting({
      id: "evt-p2-1",
      clientId: "C2",
      partitions: ["P2"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "evt-p1-1",
      clientId: "C2",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      now: now(),
    });
    await serverStore.commitOrGetExisting({
      id: "evt-p2-2",
      clientId: "C2",
      partitions: ["P2"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      now: now(),
    });

    const server = makeServer({ store: serverStore, now: createNowFactory() });
    const node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store: createInMemoryClientStore(),
      now: createNowFactory(),
      uuid: createUuidFactory("evt"),
      partitions: ["P1"],
    });

    await node.client.start();
    await tick();

    await node.client.setPartitions(["P1", "P2"], { sinceCommittedId: 0 });
    await node.client.syncNow({ sinceCommittedId: 0 });
    await tick();

    const committedIds = readCommittedIds(node.store);
    expect(committedIds).toEqual(["evt-p1-1", "evt-p2-1", "evt-p2-2"]);

    // Run a full union catch-up again: result should remain deduped.
    await node.store.applyCommittedBatch({
      events: node.store._debug.getCommitted(),
      nextCursor: await node.store.loadCursor(),
    });

    expect(readCommittedIds(node.store)).toEqual([
      "evt-p1-1",
      "evt-p2-1",
      "evt-p2-2",
    ]);
  });

  it("SC-13/SC-15: crash after persist before reply resolves via reconnect + sync", async () => {
    const baseStore = createInMemorySyncStore();
    let crashOnce = true;

    const crashingStore = {
      ...baseStore,
      commitOrGetExisting: async (input) => {
        const result = await baseStore.commitOrGetExisting(input);
        if (crashOnce) {
          crashOnce = false;
          throw new Error("crash-after-persist");
        }
        return result;
      },
    };

    let server = makeServer({
      store: crashingStore,
      now: createNowFactory(),
    });

    const clientStore = createInMemoryClientStore();
    let node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store: clientStore,
      now: createNowFactory(),
      uuid: () => "evt-crash-1",
    });

    await node.client.start();
    await tick();

    await node.client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await tick();

    // restart server with persistent store after crash
    server = makeServer({
      store: baseStore,
      now: createNowFactory(),
    });

    await node.client.stop();
    node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store: clientStore,
      now: createNowFactory(),
      uuid: () => "evt-crash-1",
    });

    await node.client.start();
    await node.client.syncNow();
    await tick();

    const committed = node.store._debug.getCommitted();
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: "evt-crash-1", committed_id: 1 });
    expect(node.store._debug.getDrafts()).toHaveLength(0);

    await node.client.submitEvent({
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
    });
    await tick();

    expect(node.store._debug.getCommitted()).toHaveLength(1);
  });

  it("SC-14: concurrent writes converge by committed_id order", async () => {
    const serverStore = createInMemorySyncStore();
    const server = makeServer({ store: serverStore, now: createNowFactory() });

    const c1 = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store: createInMemoryClientStore(),
      now: createNowFactory(),
      uuid: createUuidFactory("c1"),
    });
    const c2 = createClientNode({
      server,
      token: "C2",
      clientId: "C2",
      store: createInMemoryClientStore(),
      now: createNowFactory(),
      uuid: createUuidFactory("c2"),
    });

    await c1.client.start();
    await c2.client.start();
    await tick();

    await Promise.all([
      c1.client.submitEvent({
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { v: "U1" } } },
      }),
      c2.client.submitEvent({
        partitions: ["P1"],
        event: { type: "event", payload: { schema: "x", data: { v: "U2" } } },
      }),
    ]);
    await tick();

    const committed = serverStore._debug.getCommitted();
    expect(committed).toHaveLength(2);
    expect(committed[0].committed_id).toBeLessThan(committed[1].committed_id);

    await c1.client.syncNow();
    await c2.client.syncNow();
    await tick();

    expect(readCommittedIds(c1.store)).toEqual(readCommittedIds(c2.store));
  });

  it("SC-16/SC-17: offline queue drain remains deterministic across reconnect", async () => {
    const serverStore = createInMemorySyncStore();
    const server = makeServer({ store: serverStore, now: createNowFactory() });
    const store = createInMemoryClientStore();

    let node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store,
      now: createNowFactory(),
      uuid: createUuidFactory("offline"),
    });

    await node.client.start();
    await tick();

    await node.client.stop();

    // offline draft creation and persistence
    await store.insertDraft({
      id: "offline-1",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 1 } } },
      createdAt: 1,
    });
    await store.insertDraft({
      id: "offline-2",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 2 } } },
      createdAt: 2,
    });
    await store.insertDraft({
      id: "offline-3",
      clientId: "C1",
      partitions: ["P1"],
      event: { type: "event", payload: { schema: "x", data: { n: 3 } } },
      createdAt: 3,
    });

    node = createClientNode({
      server,
      token: "C1",
      clientId: "C1",
      store,
      now: createNowFactory(),
      uuid: createUuidFactory("unused"),
    });

    await node.client.start();
    await node.client.flushDrafts();
    await tick();

    expect(store._debug.getDrafts()).toHaveLength(0);
    expect(store._debug.getCommitted().map((entry) => entry.id)).toEqual([
      "offline-1",
      "offline-2",
      "offline-3",
    ]);
  });

  it("SC-05/SC-16/SC-17: deterministic reconnect storm converges for multiple seeds", async () => {
    const seeds = [7, 13, 29, 42, 2026];

    for (const seed of seeds) {
      const rand = createRng(seed);
      const serverStore = createInMemorySyncStore();
      const server = makeServer({
        store: serverStore,
        now: createNowFactory(seed * 1000),
      });

      const stores = [
        createInMemoryClientStore(),
        createInMemoryClientStore(),
        createInMemoryClientStore(),
      ];
      const uuids = [
        createUuidFactory(`c1-s${seed}`),
        createUuidFactory(`c2-s${seed}`),
        createUuidFactory(`c3-s${seed}`),
      ];

      /** @type {{ client: any, store: any }[]} */
      const nodes = [];
      for (let i = 0; i < 3; i += 1) {
        const node = createClientNode({
          server,
          token: `C${i + 1}`,
          clientId: `C${i + 1}`,
          store: stores[i],
          now: createNowFactory(seed * 100 + i),
          uuid: uuids[i],
        });
        nodes.push(node);
        await node.client.start();
      }
      await tick();

      for (let step = 0; step < 120; step += 1) {
        const index = Math.floor(rand() * nodes.length);
        const node = nodes[index];
        const action = rand();

        if (action < 0.45) {
          await node.client.submitEvent({
            partitions: ["P1"],
            event: {
              type: "event",
              payload: { schema: "storm", data: { seed, step, index } },
            },
          });
        } else if (action < 0.6) {
          await node.client.syncNow();
        } else if (action < 0.75) {
          await node.client.flushDrafts();
        } else if (action < 0.88) {
          await node.client.stop();
          const restarted = createClientNode({
            server,
            token: `C${index + 1}`,
            clientId: `C${index + 1}`,
            store: stores[index],
            now: createNowFactory(seed * 100 + index + step),
            uuid: uuids[index],
          });
          nodes[index] = restarted;
          await restarted.client.start();
        } else {
          await node.client.setPartitions(["P1"]);
        }
      }

      for (let i = 0; i < nodes.length; i += 1) {
        await nodes[i].client.syncNow();
        await nodes[i].client.flushDrafts();
      }
      await tick();

      const serverIds = serverStore._debug
        .getCommitted()
        .map((entry) => entry.id)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      for (const store of stores) {
        expect(readCommittedIds(store)).toEqual(serverIds);
        expect(store._debug.getDrafts()).toHaveLength(0);
      }

      const committedNumbers = serverStore._debug
        .getCommitted()
        .map((entry) => entry.committed_id);
      const uniqueNumbers = new Set(committedNumbers);
      expect(uniqueNumbers.size).toBe(committedNumbers.length);
      for (let i = 1; i <= committedNumbers.length; i += 1) {
        expect(uniqueNumbers.has(i)).toBe(true);
      }
    }
  });
});
