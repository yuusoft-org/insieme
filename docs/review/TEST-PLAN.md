# Insieme v3 — Comprehensive Automated Test Plan

**Plain JavaScript. Vitest framework. Memory SQLite for real storage behavior. Zero mocks on protocol paths.**

---

## Design Principles

1. **Real storage, not mocks** — every test uses either in-memory store or `:memory:` SQLite. This catches schema bugs, transaction bugs, locking bugs.
2. **Real protocol, not stubs** — the loopback transport passes actual message objects through the real `attachConnection` → `receive()` → `handleMessage()` path. No "we called a method and it returned" cheating.
3. **Deterministic by default** — injected clock, injected UUID factory, seeded RNG for chaos tests. Tests are repeatable.
4. **Chaos by choice** — separate suite that deliberately introduces failures at every layer.
5. **No TypeScript** — plain JS with JSDoc.

---

## Test Architecture

```
spec/
  harness/                          ← NEW: shared test infrastructure
    create-test-server.js           ← factory: full server with real SQLite
    create-test-client.js           ← factory: full client with real SQLite
    create-loopback-pair.js         ← wire client ↔ server through loopback
    create-flaky-transport.js       ← transport that drops/injects delays
    create-partitioned-world.js     ← N clients + 1 server + project setup
    event-helpers.js                ← makeEvent(), makeBatch(), etc.
    assertions.js                   ← custom vitest matchers
    sqlite-helpers.js               ← :memory: db creation, schema introspection
  integration/                      ← NEW: real-world scenario tests
    collaborative-editing.test.js
    offline-then-sync.test.js
    multi-project-isolation.test.js
    projection-replay.test.js
    graceful-shutdown.test.js
    batch-commit-correctness.test.js
    broadcast-fanout.test.js
    reconnection-storm.test.js
    concurrent-writers.test.js
    cursor-monotonicity.test.js
  chaos/                            ← NEW: fault injection
    network-partition.test.js
    store-failure-mid-batch.test.js
    sqlite-lock-contention.test.js
    random-disconnect.test.js
    slow-client-backpressure.test.js
    memory-pressure.test.js
  regression/                       ← NEW: specific bug reproductions
    F1-broadcast-cascade.test.js
    F2-store-error-drops-batch.test.js
    F3-graceful-shutdown-dataloss.test.js
    F4-receivequeue-rejection.test.js
    F5-syncinprogress-stuck.test.js
    P1-broadcast-scan-perf.test.js
    P2-write-amplification.test.js
  protocol/                         ← EXISTING: keep all current tests
    ...
```

---

## Part 1: Test Harness (`spec/harness/`)

### 1.1 `create-test-server.js`

Sets up a complete server with real SQLite, ready for connections.

```js
import { createSyncServer } from "../../src/index.js";
import { createSqliteDb } from "../protocol/src/helpers/sqlite-db.js";
import { createSqliteSyncStore } from "../../src/index.js";

/**
 * @param {object} [options]
 * @param {number} [options.nowStart=1000]
 * @param {Function} [options.verifyToken]
 * @param {Function} [options.authorize]
 * @param {Function} [options.validate]
 * @param {Function} [options.logger]
 * @param {object} [options.limits]
 * @returns {Promise<{ server: object, store: object, db: object, now: Function, close: Function }>}
 */
export const createTestServer = async ({
  nowStart = 1000,
  verifyToken,
  authorize,
  validate,
  logger = () => {},
  limits,
} = {}) => {
  let nowValue = nowStart;
  const now = () => { nowValue += 1; return nowValue; };

  const db = createSqliteDb(":memory:");
  const store = createSqliteSyncStore(db);
  await store.init();

  const server = createSyncServer({
    auth: {
      verifyToken: verifyToken || (async (token) => ({ clientId: token, claims: {} })),
      validateSession: undefined,
    },
    authz: {
      authorizeProject: authorize || (async () => true),
    },
    validation: { validate: validate || (async () => {}) },
    store,
    clock: { now },
    logger,
    limits,
  });

  return {
    server,
    store,
    db,
    now,
    close: () => { try { db.close(); } catch {} },
  };
};
```

### 1.2 `create-test-client.js`

Sets up a client with real SQLite, wired to a server through a loopback transport.

```js
import { createSqliteClientStore, createSyncClient } from "../../src/index.js";
import { createSqliteDb } from "../protocol/src/helpers/sqlite-db.js";

/**
 * Creates a full client node (store + transport + sync client) wired to a server.
 * 
 * @param {object} options
 * @param {object} options.server - from createTestServer()
 * @param {string} options.clientId
 * @param {string} [options.projectId="proj-1"]
 * @param {Function} [options.now]
 * @param {Function} [options.uuid]
 * @param {Function} [options.validateLocalEvent]
 * @returns {Promise<{ client: object, store: object, db: object, transport: object, close: Function }>}
 */
export const createTestClient = async ({
  server,
  clientId,
  projectId = "proj-1",
  now,
  uuid,
  validateLocalEvent,
}) => {
  const db = createSqliteDb(":memory:");
  const store = createSqliteClientStore(db);
  await store.init();

  const transport = createLoopbackTransport({
    server,
    connectionId: `conn-${clientId}`,
  });

  const client = createSyncClient({
    transport,
    store,
    token: clientId,
    clientId,
    projectId,
    now,
    uuid,
    validateLocalEvent,
  });

  return {
    client,
    store,
    db,
    transport,
    close: () => { try { client.stop(); } catch {} try { db.close(); } catch {} },
  };
};
```

### 1.3 `create-loopback-pair.js`

The loopback transport — zero-copy message passing between client and server. Already proven in the existing test suite, we extract and enhance it.

**Key enhancement over existing:** Support for controlled message dropping, reordering, and delays.

```js
/**
 * Create a loopback transport with optional fault injection.
 * 
 * @param {object} options
 * @param {object} options.server
 * @param {string} options.connectionId
 * @param {object} [options.faults]
 * @param {number} [options.faults.dropRate=0] — 0..1 probability of dropping each message
 * @param {number} [options.faults.delayMs=0] — artificial delay on each message
 * @param {number} [options.faults.reorderRate=0] — probability of reordering adjacent messages
 * @param {Function} [options.faults.rng] — seeded RNG for deterministic faults
 */
export const createLoopbackTransport = ({ server, connectionId, faults }) => {
  let onMessage = null;
  let session = null;
  let connected = false;
  const sentMessages = [];  // ← NEW: message log for assertions
  const receivedMessages = [];

  const rng = faults?.rng || Math.random;
  const dropRate = faults?.dropRate || 0;
  const delayMs = faults?.delayMs || 0;
  const reorderRate = faults?.reorderRate || 0;

  const serverTransport = {
    connectionId,
    send: async (message) => {
      receivedMessages.push(message);
      if (onMessage) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        onMessage(message);
      }
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
      if (!connected || !session) throw new Error("transport disconnected");
      // Fault injection: drop
      if (dropRate > 0 && rng() < dropRate) {
        sentMessages.push({ ...message, _dropped: true });
        return; // silently drop
      }
      sentMessages.push(message);
      await session.receive(message);
    },
    onMessage: (handler) => {
      onMessage = handler;
      return () => { if (onMessage === handler) onMessage = null; };
    },
    isConnected: () => connected,
    getSentMessages: () => [...sentMessages],
    getReceivedMessages: () => [...receivedMessages],
    clearLogs: () => { sentMessages.length = 0; receivedMessages.length = 0; },
  };
};
```

### 1.4 `create-flaky-transport.js`

Wraps any transport and adds controlled failures.

```js
/**
 * Wraps a transport and introduces controlled failures.
 * Call .failNextSend(), .failNextReceive(), .delayNext() etc.
 */
export const createFlakyTransport = (inner) => {
  let failNextSend = false;
  let failNextReceive = false;
  let delayMs = 0;
  let disconnectAfterSend = false;

  return {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    send: async (message) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("transport_send_failed");
      }
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      const result = inner.send(message);
      if (disconnectAfterSend) {
        disconnectAfterSend = false;
        await inner.disconnect();
      }
      return result;
    },
    onMessage: (handler) => inner.onMessage(handler),
    isConnected: () => inner.isConnected(),
    // Control methods
    failNext: () => { failNextSend = true; },
    failNextRecv: () => { failNextReceive = true; },
    setDelay: (ms) => { delayMs = ms; },
    disconnectAfter: () => { disconnectAfterSend = true; },
  };
};
```

### 1.5 `create-partitioned-world.js`

Sets up a full multi-client collaborative environment for integration testing.

```js
/**
 * Creates N clients connected to one server, all in the same project.
 * Each client gets its own :memory: SQLite database.
 * 
 * @param {object} options
 * @param {number} options.clientCount
 * @param {string} [options.projectId="proj-1"]
 * @param {object} [options.serverOptions]
 * @returns {Promise<{ server: object, clients: Array, close: Function }>}
 */
export const createPartitionedWorld = async ({
  clientCount,
  projectId = "proj-1",
  serverOptions = {},
}) => {
  const { server, store: serverStore, now, close: closeServer } = await createTestServer(serverOptions);
  const clients = [];

  for (let i = 0; i < clientCount; i++) {
    const clientId = `C${i + 1}`;
    const node = await createTestClient({
      server,
      clientId,
      projectId,
      now,
    });
    clients.push(node);
  }

  return {
    server,
    serverStore,
    clients,
    now,
    close: () => {
      clients.forEach(c => c.close());
      closeServer();
    },
  };
};
```

### 1.6 `event-helpers.js`

```js
let eventCounter = 0;
const defaultNow = () => Date.now();

export const makeEvent = (overrides = {}) => ({
  id: `evt-${++eventCounter}`,
  partition: "P1",
  type: "test_event",
  schemaVersion: 1,
  payload: {},
  meta: { clientId: "C1", clientTs: defaultNow() },
  ...overrides,
});

export const makeBatch = (count, overrides = {}) =>
  Array.from({ length: count }, (_, i) =>
    makeEvent({ ...overrides, payload: { n: i + 1 } })
  );

export const resetEventCounter = () => { eventCounter = 0; };

/** Collect all events emitted to a client over N ticks */
export const collectEvents = async (client, ticks = 5) => {
  const events = [];
  const unsub = client.onEvent((entry) => events.push(entry));
  for (let i = 0; i < ticks; i++) await tick();
  unsub();
  return events;
};

export const tick = () => new Promise(r => setTimeout(r, 0));
export const tickN = (n) => Promise.all(Array.from({ length: n }, () => tick()));
```

### 1.7 `assertions.js`

```js
import { expect } from "vitest";

expect.extend({
  toHaveCommittedIds(store, expectedIds) {
    const actual = store._debug.getCommitted().map(e => e.id).sort();
    const pass = JSON.stringify(actual) === JSON.stringify([...expectedIds].sort());
    return {
      pass,
      message: () => `Expected committed IDs ${this.isNot ? "not " : ""}to be ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actual)}`,
    };
  },
  toHaveCursorAt(store, expectedCursor) {
    // Async check — caller must await
    return store.loadCursor().then(cursor => ({
      pass: cursor === expectedCursor,
      message: () => `Expected cursor ${this.isNot ? "not " : ""}to be ${expectedCursor}, got ${cursor}`,
    }));
  },
  toHaveDraftCount(store, expected) {
    const actual = store._debug.getDrafts().length;
    return {
      pass: actual === expected,
      message: () => `Expected draft count ${this.isNot ? "not " : ""}to be ${expected}, got ${actual}`,
    };
  },
});
```

---

## Part 2: Integration Tests (`spec/integration/`)

Each test simulates a real-world user scenario end-to-end.

### 2.1 `collaborative-editing.test.js`

**Scenario:** 5 users editing the same document simultaneously. Each submits events. All clients converge to the same state.

```js
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createPartitionedWorld } from "../harness/create-partitioned-world.js";
import { collectEvents, tickN, makeEvent } from "../harness/event-helpers.js";

describe("collaborative editing", () => {
  let world;
  
  beforeEach(async () => {
    world = await createPartitionedWorld({ clientCount: 5 });
  });
  
  afterEach(() => world?.close());

  it("5 clients submit simultaneously, all converge to same event set", async () => {
    // Start all clients
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(3);

    // Each client submits 10 events simultaneously
    const submissions = world.clients.map((node, i) =>
      Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          node.client.submitEvent({
            partition: "P1",
            type: "edit",
            schemaVersion: 1,
            payload: { client: i, op: j },
          })
        )
      )
    );
    await Promise.all(submissions);
    await tickN(10);

    // Every client should have all 50 events
    for (const node of world.clients) {
      const committed = node.store._debug.getCommitted();
      expect(committed).toHaveLength(50);
    }

    // All clients should have the same events in committedId order
    const expected = world.clients[0].store._debug.getCommitted()
      .map(e => e.id).sort();
    for (const node of world.clients) {
      const ids = node.store._debug.getCommitted().map(e => e.id).sort();
      expect(ids).toEqual(expected);
    }
  });

  it("late-joining client catches up to existing events via sync", async () => {
    const [first, ...rest] = world.clients;

    // Start first client, submit 20 events
    await first.client.start();
    await tickN(3);
    for (let i = 0; i < 20; i++) {
      await first.client.submitEvent({
        partition: "P1",
        type: "edit",
        schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);

    // Now start the other clients — they should sync from 0
    await Promise.all(rest.map(c => c.client.start()));
    await tickN(10);

    // All clients have 20 events
    for (const node of world.clients) {
      expect(node.store._debug.getCommitted()).toHaveLength(20);
    }
  });

  it("client that disconnects mid-session reconnects and catches up", async () => {
    const [first, second] = world.clients;
    
    await first.client.start();
    await second.client.start();
    await tickN(3);

    // Client 1 submits 10 events
    for (let i = 0; i < 10; i++) {
      await first.client.submitEvent({
        partition: "P1",
        type: "edit",
        schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);
    expect(second.store._debug.getCommitted()).toHaveLength(10);

    // Client 2 disconnects
    await second.client.stop();
    await tickN(2);

    // Client 1 submits 10 more events while client 2 is offline
    for (let i = 10; i < 20; i++) {
      await first.client.submitEvent({
        partition: "P1",
        type: "edit",
        schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);

    // Client 2 reconnects
    await second.client.start();
    await tickN(10);

    // Client 2 has all 20 events now
    expect(second.store._debug.getCommitted()).toHaveLength(20);
  });
});
```

### 2.2 `offline-then-sync.test.js`

**Scenario:** Client goes offline, queues 50 events, reconnects, all events drain and commit.

```js
describe("offline then sync", () => {
  it("client queues 50 events offline, drains all on reconnect", async () => {
    const { server, close: closeServer } = await createTestServer();
    const node = await createTestClient({ server, clientId: "C1" });
    
    // Start and immediately disconnect (simulate going offline)
    await node.client.start();
    await tickN(3);
    await node.transport.disconnect();
    await tickN(2);

    // Submit 50 events while offline (should be queued as drafts)
    for (let i = 0; i < 50; i++) {
      await node.client.submitEvent({
        partition: "P1",
        type: "edit",
        schemaVersion: 1,
        payload: { n: i },
      });
    }

    // Drafts should be queued
    expect(node.store._debug.getDrafts()).toHaveLength(50);

    // Reconnect
    await node.client.start();
    await tickN(20);

    // All drafts should be committed
    expect(node.store._debug.getDrafts()).toHaveLength(0);
    expect(node.store._debug.getCommitted()).toHaveLength(50);
    
    node.close();
    closeServer();
  });

  it("offline events get server-assigned committedIds in order", async () => {
    // ... verifies committedIds are sequential after drain
  });

  it("partial drain — only first batch commits, rest retries on next start", async () => {
    // Server rejects some events (validation fails on 3rd of 50)
    // Verify: first 2 committed, rest not processed, drafts remain for items 3-50
  });
});
```

### 2.3 `multi-project-isolation.test.js`

**Scenario:** Client A in project X, client B in project Y. Events don't leak.

```js
describe("multi-project isolation", () => {
  it("events in project X never appear in project Y's sync", async () => {
    const serverCtx = await createTestServer();
    
    const clientX = await createTestClient({
      server: serverCtx.server,
      clientId: "CX",
      projectId: "proj-x",
    });
    const clientY = await createTestClient({
      server: serverCtx.server,
      clientId: "CY",
      projectId: "proj-y",
    });

    await clientX.client.start();
    await clientY.client.start();
    await tickN(3);

    // Client X submits 20 events
    for (let i = 0; i < 20; i++) {
      await clientX.client.submitEvent({
        partition: "P1", type: "edit", schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);

    // Client Y should have ZERO events from project X
    expect(clientY.store._debug.getCommitted()).toHaveLength(0);

    // Client Y submits its own events
    for (let i = 0; i < 10; i++) {
      await clientY.client.submitEvent({
        partition: "P1", type: "edit", schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);

    expect(clientY.store._debug.getCommitted()).toHaveLength(10);
    expect(clientX.store._debug.getCommitted()).toHaveLength(20); // Still only its own

    clientX.close();
    clientY.close();
    serverCtx.close();
  });

  it("client switching projects sees only the new project's events", async () => {
    // Client connects to proj-x, submits, then reconnects to proj-y
    // Verifies no cross-contamination
  });
});
```

### 2.4 `projection-replay.test.js`

**Scenario:** Register a view, submit events, verify projection state, simulate crash (no checkpoint), verify replay from scratch produces same result.

### 2.5 `graceful-shutdown.test.js`

**Scenario:** Server is processing a 50-event submit. Call shutdown(). Verify: submit_events_result is sent before session closes.

```js
describe("graceful shutdown", () => {
  it("server sends submit_events_result before closing on shutdown", async () => {
    const { server, close: closeServer } = await createTestServer();
    const node = await createTestClient({ server, clientId: "C1" });
    await node.client.start();
    await tickN(3);

    // Submit a large batch
    const submitPromise = node.client.submitEvent({
      partition: "P1", type: "edit", schemaVersion: 1,
      payload: { n: 1 },
    });

    // Immediately trigger shutdown
    const shutdownPromise = server.shutdown();

    // The submit should complete (not throw)
    await expect(submitPromise).resolves.toBeDefined();
    await shutdownPromise;

    node.close();
    closeServer();
  });

  it("in-flight sync completes before shutdown closes session", async () => {
    // Client requests sync, server shuts down mid-sync
    // Client should receive the sync_response page, not an error
  });
});
```

### 2.6 `batch-commit-correctness.test.js`

Tests the new batch commit path with real SQLite.

```js
describe("batch commit correctness", () => {
  it("50 events committed in one transaction — all or nothing", async () => {
    // Commit 50 events via batch
    // Verify: all 50 in DB, committedIds sequential
    // Kill process mid-transaction (using separate process like crash-commit-sync-store.js)
    // Verify: either all 50 committed or zero
  });

  it("duplicate events within a batch are deduped", async () => {
    // Submit 10 events where 3 have duplicate IDs
    // Verify: 7 committed, 3 deduped, results array has correct statuses
  });

  it("batch commit under concurrent writer lock retries and succeeds", async () => {
    // Lock the DB externally, attempt batch commit, release lock, verify success
  });
});
```

### 2.7 `broadcast-fanout.test.js`

Tests the per-project session index and broadcast correctness.

```js
describe("broadcast fanout", () => {
  it("event committed by C1 is received by C2-C100 but not C101 (different project)", async () => {
    const world = await createPartitionedWorld({ clientCount: 100 });
    // ... 100 clients in proj-1, submit event from C1
    // Verify all 99 others receive broadcast
  });

  it("broadcast to dead recipient does not cascade to other recipients", async () => {
    // This is the F1 regression test
    // 10 clients, disconnect C5, submit from C1
    // Verify C1-C4, C6-C10 all receive broadcast
  });
});
```

### 2.8 `reconnection-storm.test.js`

**Scenario:** 10 clients all disconnect and reconnect simultaneously. Convergence guaranteed.

```js
describe("reconnection storm", () => {
  it("10 clients disconnect and reconnect simultaneously — all converge", async () => {
    const world = await createPartitionedWorld({ clientCount: 10 });
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(3);

    // Client 1 submits 20 events
    for (let i = 0; i < 20; i++) {
      await world.clients[0].client.submitEvent({
        partition: "P1", type: "edit", schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);

    // All 10 disconnect at once
    await Promise.all(world.clients.map(c => c.client.stop()));
    await tickN(2);

    // Client 1 submits 20 more while everyone is offline
    await world.clients[0].client.start();
    await tickN(2);
    for (let i = 20; i < 40; i++) {
      await world.clients[0].client.submitEvent({
        partition: "P1", type: "edit", schemaVersion: 1,
        payload: { n: i },
      });
    }
    await tickN(5);
    await world.clients[0].client.stop();

    // All 10 reconnect at once
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(20);

    // Every client has all 40 events
    for (const node of world.clients) {
      const committed = node.store._debug.getCommitted();
      expect(committed).toHaveLength(40);
    }

    world.close();
  });
});
```

### 2.9 `concurrent-writers.test.js`

**Scenario:** 10 clients all submit 100 events simultaneously. No data loss, no corruption.

### 2.10 `cursor-monotonicity.test.js`

**Scenario:** Cursor only moves forward. Out-of-order events don't regress it. Duplicate replays don't double-advance it.

---

## Part 3: Chaos Tests (`spec/chaos/`)

### 3.1 `network-partition.test.js`

```js
describe("network partition chaos", () => {
  it("random disconnect/reconnect over 100 operations — no data loss", async () => {
    const world = await createPartitionedWorld({ clientCount: 5 });
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(3);

    const rng = createRng(42); // Seeded for determinism
    let totalSubmitted = 0;

    for (let round = 0; round < 100; round++) {
      // Pick a random client
      const idx = Math.floor(rng() * 5);
      const node = world.clients[idx];

      // 70% chance: submit an event
      if (rng() < 0.7) {
        try {
          await node.client.submitEvent({
            partition: "P1", type: "edit", schemaVersion: 1,
            payload: { round, client: idx },
          });
          totalSubmitted++;
        } catch {} // May fail if disconnected
      }

      // 10% chance: disconnect a random client
      if (rng() < 0.1) {
        const dIdx = Math.floor(rng() * 5);
        try { await world.clients[dIdx].client.stop(); } catch {}
      }

      // 10% chance: reconnect a disconnected client
      if (rng() < 0.1) {
        const rIdx = Math.floor(rng() * 5);
        try { await world.clients[rIdx].client.start(); } catch {}
      }

      await tickN(1);
    }

    // Let everything settle
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(20);

    // All clients should have exactly totalSubmitted events
    for (const node of world.clients) {
      expect(node.store._debug.getCommitted()).toHaveLength(totalSubmitted);
    }

    world.close();
  });
});
```

### 3.2 `store-failure-mid-batch.test.js`

```js
describe("store failure mid-batch", () => {
  it("store throws on event 25 of 50 — client receives result for all 50", async () => {
    // Create a store wrapper that throws on the 25th commit
    let commitCount = 0;
    const { server, store: realStore, close: closeServer } = await createTestServer({
      validate: async (item) => {
        commitCount++;
        if (commitCount === 25) {
          const err = new Error("simulated store failure");
          err.code = "server_error";
          throw err;
        }
      },
    });

    // Client submits 50 events
    // Verify: results array has 50 entries
    // First 24: committed. #25: rejected or not_processed. 26-50: varies by implementation.
  });
});
```

### 3.3 `sqlite-lock-contention.test.js`

```js
describe("sqlite lock contention", () => {
  it("10 concurrent writers with 0ms busy timeout — all eventually succeed", async () => {
    // 10 clients each submitting 50 events to the same :memory: SQLite
    // All using busyTimeoutMs: 0 (immediate fail on lock)
    // Expect: all 500 events eventually committed after retries
  });

  it("external locker holds DB for 500ms — operations queue and resume", async () => {
    // Open a second connection, BEGIN IMMEDIATE, hold for 500ms
    // Client operations during that window should fail
    // After release, operations succeed
  });

  it("WAL checkpoint during heavy write load — no data corruption", async () => {
    // Continuously write events while forcing WAL checkpoints
    // Verify: all events readable, no duplicates, no gaps in committedIds
  });
});
```

### 3.4 `random-disconnect.test.js`

```js
describe("random disconnect", () => {
  it("transport disconnects at random points during 200 operations", async () => {
    // Use createFlakyTransport with controlled failure points
    // Disconnect at: during handshake, mid-sync, mid-submit, mid-broadcast
    // Verify: client reconnects, syncs, no data loss
  });
});
```

### 3.5 `slow-client-backpressure.test.js`

```js
describe("slow client backpressure", () => {
  it("server sends 1000 events to slow client — no unbounded memory growth", async () => {
    // Create a transport that delays each message by 10ms
    // Server commits 1000 events rapidly
    // Verify: server doesn't crash, memory stays bounded
    // (This test validates the backpressure fix from P3)
  });
});
```

---

## Part 4: Regression Tests (`spec/regression/`)

Each test is named after the bug it prevents from recurring.

### 4.1 `F1-broadcast-cascade.test.js`

```js
describe("F1 regression: broadcast cascade", () => {
  it("one dead recipient does not prevent other recipients from receiving events", async () => {
    const world = await createPartitionedWorld({ clientCount: 5 });
    await Promise.all(world.clients.map(c => c.client.start()));
    await tickN(3);

    // Kill client 3's transport (simulate dead socket)
    await world.clients[2].transport.disconnect();
    await tickN(1);

    // Client 1 submits an event
    await world.clients[0].client.submitEvent({
      partition: "P1", type: "edit", schemaVersion: 1,
      payload: { test: "F1" },
    });
    await tickN(5);

    // Clients 2, 4, 5 should ALL have the event (client 3 won't, it's dead)
    expect(world.clients[1].store._debug.getCommitted()).toHaveLength(1);
    expect(world.clients[3].store._debug.getCommitted()).toHaveLength(1);
    expect(world.clients[4].store._debug.getCommitted()).toHaveLength(1);

    // Client 1 (submitter) should NOT be disconnected
    expect(world.clients[0].transport.isConnected()).toBe(true);

    world.close();
  });
});
```

### 4.2 `F2-store-error-drops-batch.test.js`

```js
describe("F2 regression: store error drops batch", () => {
  it("store error on event 3 — client receives result with all 5 items", async () => {
    let callCount = 0;
    const { server, close } = await createTestServer({
      validate: async () => {
        callCount++;
        if (callCount === 3) throw new Error("store explode");
      },
    });

    // ... submit 5 events, verify submit_events_result has 5 entries
  });
});
```

### 4.3 `F3-graceful-shutdown-dataloss.test.js`
### 4.4 `F4-receivequeue-rejection.test.js`
### 4.5 `F5-syncinprogress-stuck.test.js`

```js
describe("F5 regression: syncInProgress stuck forever", () => {
  it("sync error resets syncInProgress — subsequent syncs succeed", async () => {
    // Start sync, cause error mid-sync (store throws during listCommittedSince)
    // Verify: syncInProgress is reset
    // Verify: next sync request succeeds
  });
});
```

### 4.6 `P1-broadcast-scan-perf.test.js`

```js
describe("P1 regression: broadcast scan", () => {
  it("broadcast with 1000 sessions completes in <100ms", async () => {
    // Create server with 1000 connected sessions across 10 projects
    // Time the broadcastCommitted call
    // Assert <100ms
  });
});
```

### 4.7 `P2-write-amplification.test.js`

```js
describe("P2 regression: write amplification", () => {
  it("batch of 50 events uses single transaction", async () => {
    // Instrument the SQLite DB to count SQL statements
    // Commit 50 events
    // Verify: < 60 SQL statements (not 150)
  });
});
```

---

## Part 5: Running the Tests

### NPM Scripts

```json
{
  "test": "vitest --run",
  "test:watch": "vitest",
  "test:integration": "vitest --run spec/integration",
  "test:chaos": "vitest --run spec/chaos",
  "test:regression": "vitest --run spec/regression",
  "test:protocol": "vitest --run spec/protocol",
  "test:all": "vitest --run spec",
  "test:stress": "for i in 1 2 3; do vitest --run spec/chaos; done",
  "test:coverage": "vitest --run --coverage"
}
```

### CI Pipeline

```
1. test:protocol     — must pass, <30s
2. test:integration  — must pass, <60s
3. test:chaos        — must pass, run 3x for flake detection, <120s
4. test:regression   — must pass, <30s
5. test:coverage     — enforce thresholds
```

---

## Part 6: What We DON'T Test

| What | Why |
|---|---|
| IndexedDB | Requires browser environment. Existing tests use FakeIndexedDB — keep them. |
| WebSocket wire format | We test at the protocol layer (message objects), not the TCP layer. Loopback is sufficient. |
| Redis Pub/Sub | Not implemented yet. Will need a real Redis instance in CI when Phase 6 is done. |
| Auth token crypto | We inject verifyToken. Token crypto is the consumer's responsibility. |

---

## Test Count Summary

| Suite | Tests | Lines (est.) |
|---|---|---|
| Harness (shared infra) | 0 (utilities) | ~400 |
| Integration | ~35 | ~1,500 |
| Chaos | ~15 | ~800 |
| Regression | ~10 | ~500 |
| **New total** | **~60** | **~3,200** |
| Existing protocol tests | ~80 | ~10,569 |
| **Grand total** | **~140** | **~13,769** |

---

## Implementation Order

1. **Harness first** — `spec/harness/` (all 7 files). ~1 day.
2. **Regression tests** — `spec/regression/` (7 files, one per bug). ~1 day.
3. **Integration tests** — `spec/integration/` (10 files). ~2-3 days.
4. **Chaos tests** — `spec/chaos/` (6 files). ~2 days.

**Total: ~6-7 days.** Can start immediately, independent of implementation phases.
