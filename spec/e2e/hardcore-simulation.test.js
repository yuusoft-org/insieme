import { describe, expect, it } from "vitest";
import {
  createInMemoryClientStore,
  createSyncClient,
} from "../../src/index.js";
import { partitionSetBelongsToProject } from "../../src/partition-scope.js";
import { createRng } from "../harness/event-helpers.js";
import { createFaultTransport } from "../harness/fault-transport.js";
import {
  assertCommittedIdsStrictlyIncreasing,
  assertNoDrafts,
  readCommittedEvents,
} from "../harness/history-checker.js";
import { runScenario } from "../harness/scenario-runner.js";
import { createTestServer } from "../harness/create-test-server.js";

const PROJECT_ID = "proj-prod";
const OTHER_PROJECT_ID = "proj-secret";
const DENIED_PROJECT_ID = "proj-denied";

let connectionCounter = 0;

const committedIdOf = (event) => event.committedId ?? event.committed_id;

const projectEvents = (events, projectId) =>
  events.filter((event) => partitionSetBelongsToProject(event.partitions, projectId));

const eventIds = (events) => events.map((event) => event.id);

const createSimulationServer = () =>
  createTestServer({
    validate: async (item) => {
      if (item.event?.payload?.data?.reject === true) {
        const error = new Error("simulated domain rejection");
        error.code = "validation_failed";
        throw error;
      }
    },
    authorize: async (_identity, projectId) => projectId !== DENIED_PROJECT_ID,
    limits: {
      maxInboundMessagesPerWindow: 10_000,
    },
  });

const seedBackend = async ({ serverStore, now, trace }) => {
  for (let index = 1; index <= 650; index += 1) {
    await serverStore.commitOrGetExisting({
      id: `seed-prod-${index}`,
      partition: index % 2 === 0 ? "tasks" : "docs",
      projectId: PROJECT_ID,
      type: "seed.created",
      schemaVersion: 1,
      payload: { index },
      meta: { clientId: "seed", clientTs: index },
      now: now(),
    });
  }

  for (let index = 1; index <= 25; index += 1) {
    await serverStore.commitOrGetExisting({
      id: `seed-secret-${index}`,
      partition: "private",
      projectId: OTHER_PROJECT_ID,
      type: "secret.created",
      schemaVersion: 1,
      payload: { index },
      meta: { clientId: "seed-secret", clientTs: index },
      now: now(),
    });
  }

  trace.record("server.seeded", {
    projectEvents: 650,
    otherProjectEvents: 25,
  });
};

const makeClient = ({
  server,
  trace,
  clientId,
  projectId = PROJECT_ID,
  faults = [],
  store = createInMemoryClientStore(),
}) => {
  let nowValue = 100_000;
  let uuidIndex = 0;
  const events = [];
  const transport = createFaultTransport({
    server,
    connectionId: `conn-${clientId}-${++connectionCounter}`,
    trace,
    faults,
  });
  const client = createSyncClient({
    transport,
    store,
    token: clientId,
    clientId,
    projectId,
    now: () => {
      nowValue += 1;
      return nowValue;
    },
    uuid: () => `evt-${clientId}-auto-${++uuidIndex}`,
    onEvent: (event) => {
      events.push(event);
      trace.record("client.event", {
        clientId,
        type: event.type,
      });
    },
    logger: (entry) => {
      if (entry.event === "handler_error" || entry.event === "transport_disconnected") {
        trace.record("client.log", {
          clientId,
          event: entry.event,
          message: entry.message,
          code: entry.code,
        });
      }
    },
    reconnect: { enabled: false },
    submitBatch: {
      maxEvents: 8,
    },
  });

  return {
    client,
    trace,
    clientId,
    events,
    projectId,
    store,
    transport,
  };
};

const submitEvent = async ({ runtime, id, partition, payload }) => {
  runtime.trace.record("client.submit", {
    clientId: runtime.clientId,
    id,
    partition,
  });
  await runtime.client.submitEvent({
    id,
    partition,
    type: "sim.event",
    schemaVersion: 1,
    payload,
  });
};

const submitBatch = async ({ runtime, events }) => {
  runtime.trace.record("client.submit_batch", {
    clientId: runtime.clientId,
    ids: events.map((event) => event.id),
  });
  await runtime.client.submitEvents(
    events.map((event) => ({
      id: event.id,
      partition: event.partition,
      type: "sim.batch",
      schemaVersion: 1,
      payload: event.payload,
    })),
  );
};

const restartClient = async ({ runtime, trace, tick }) => {
  trace.record("client.restart", { clientId: runtime.clientId });
  await runtime.client.stop();
  await tick(1);
  await runtime.client.start();
  await tick(5);
};

const assertProjectConvergence = async ({
  serverStore,
  clients,
  trace,
}) => {
  const serverCommitted = await readCommittedEvents(serverStore);
  await assertCommittedIdsStrictlyIncreasing({
    events: serverCommitted,
    trace,
  });

  const expectedEvents = projectEvents(serverCommitted, PROJECT_ID);
  const expectedIds = eventIds(expectedEvents);
  const expectedMaxCommittedId = committedIdOf(expectedEvents.at(-1));
  expect(expectedIds).not.toContain("evt-beta-reject");
  expect(expectedIds).not.toContain("evt-denied-should-not-commit");

  for (const runtime of clients) {
    const committed = await readCommittedEvents(runtime.store);
    const committedIds = eventIds(committed);
    expect(committedIds).toEqual(expectedIds);
    expect(
      committed.some((event) =>
        partitionSetBelongsToProject(event.partitions, OTHER_PROJECT_ID),
      ),
    ).toBe(false);
    expect(await runtime.store.loadCursor()).toBe(expectedMaxCommittedId);
    await assertNoDrafts({
      store: runtime.store,
      label: runtime.clientId,
      trace,
    });
  }
};

describe("hardcore backend and multi-client simulation", () => {
  it("converges multiple frontend clients through backend faults, validation, replay, and pagination", async () => {
    await runScenario("hardcore backend multi-client production simulation", {
      seed: 424242,
      setup: async ({ trace }) => {
        const { server, store: serverStore, now } = createSimulationServer();
        await seedBackend({ serverStore, now, trace });

        const alpha = makeClient({
          server,
          trace,
          clientId: "alpha",
          faults: [
            {
              name: "alpha-lost-submit-result",
              direction: "server_to_client",
              type: "submit_events_result",
              once: true,
            },
          ],
        });
        const beta = makeClient({
          server,
          trace,
          clientId: "beta",
          faults: [
            {
              name: "beta-missed-broadcast",
              direction: "server_to_client",
              type: "event_broadcast",
              once: true,
            },
          ],
        });
        const gamma = makeClient({
          server,
          trace,
          clientId: "gamma",
        });
        const delta = makeClient({
          server,
          trace,
          clientId: "delta",
          faults: [
            {
              name: "delta-missed-two-broadcasts",
              direction: "server_to_client",
              type: "event_broadcast",
              times: 2,
            },
          ],
        });
        const denied = makeClient({
          server,
          trace,
          clientId: "denied",
          projectId: DENIED_PROJECT_ID,
        });

        await gamma.store.insertDrafts([
          {
            id: "evt-gamma-offline-1",
            partition: "docs",
            type: "sim.offline",
            schemaVersion: 1,
            payload: { offline: 1 },
            meta: { clientId: "gamma", clientTs: 1 },
            createdAt: 1,
          },
          {
            id: "evt-gamma-offline-2",
            partition: "tasks",
            type: "sim.offline",
            schemaVersion: 1,
            payload: { offline: 2 },
            meta: { clientId: "gamma", clientTs: 2 },
            createdAt: 2,
          },
        ]);

        return {
          activeClients: [alpha, beta, gamma, delta],
          allClients: [alpha, beta, gamma, delta, denied],
          denied,
          server,
          serverStore,
        };
      },
      run: async ({
        activeClients,
        denied,
        server,
        serverStore,
        tick,
        trace,
      }) => {
        for (const runtime of activeClients) {
          trace.record("client.start", { clientId: runtime.clientId });
          await runtime.client.start();
        }
        await tick(12);

        for (const runtime of activeClients) {
          expect(await runtime.store.loadCursor()).toBe(650);
          const initialCommitted = runtime.store._debug.getCommitted();
          expect(initialCommitted.length).toBeGreaterThanOrEqual(650);
          expect(
            initialCommitted.some((event) =>
              partitionSetBelongsToProject(event.partitions, OTHER_PROJECT_ID),
            ),
          ).toBe(false);
        }

        trace.record("client.start_denied", { clientId: denied.clientId });
        await denied.client.start();
        await tick(2);
        expect(
          denied.transport
            .getReceivedMessages()
            .some(
              (message) =>
                message.type === "error" &&
                message.payload?.code === "forbidden",
            ),
        ).toBe(true);
        expect(await readCommittedEvents(denied.store)).toEqual([]);
        await denied.client.stop();

        const [alpha, beta, gamma, delta] = activeClients;
        await submitEvent({
          runtime: alpha,
          id: "evt-alpha-lost-reply",
          partition: "docs",
          payload: { client: "alpha", lostReply: true },
        });
        await tick(3);
        expect(alpha.transport.getDroppedMessages()).toHaveLength(1);
        expect(alpha.store._debug.getDrafts().map((draft) => draft.id)).toEqual([
          "evt-alpha-lost-reply",
        ]);

        await submitBatch({
          runtime: beta,
          events: [
            {
              id: "evt-beta-before-reject",
              partition: "tasks",
              payload: { client: "beta", ok: 1 },
            },
            {
              id: "evt-beta-reject",
              partition: "tasks",
              payload: { reject: true },
            },
            {
              id: "evt-beta-after-reject",
              partition: "tasks",
              payload: { client: "beta", retryAfterReject: true },
            },
          ],
        });
        await tick(8);
        expect(eventIds(await readCommittedEvents(serverStore))).toContain(
          "evt-beta-after-reject",
        );

        const rng = createRng(424242);
        for (let round = 1; round <= 8; round += 1) {
          for (const runtime of activeClients) {
            if (runtime.clientId === "alpha" && round === 1) continue;
            const batchSize = 1 + Math.floor(rng() * 3);
            const events = Array.from({ length: batchSize }, (_, index) => ({
              id: `evt-${runtime.clientId}-round-${round}-${index + 1}`,
              partition: rng() > 0.5 ? "docs" : "tasks",
              payload: {
                client: runtime.clientId,
                round,
                index,
                value: Math.floor(rng() * 1_000_000),
              },
            }));
            await submitBatch({ runtime, events });
            await tick(2);
          }

          if (round === 3) {
            await restartClient({ runtime: delta, trace, tick });
          }
          if (round === 5) {
            await gamma.client.stop();
            await submitEvent({
              runtime: gamma,
              id: "evt-gamma-offline-during-sim",
              partition: "docs",
              payload: { stoppedClientDraft: true },
            });
            await restartClient({ runtime: gamma, trace, tick });
          }
        }

        for (let index = 0; index < activeClients.length; index += 1) {
          const runtime = activeClients[index];
          trace.record("client.final_recreate", { clientId: runtime.clientId });
          await runtime.client.stop();
          await tick(1);
          const restarted = makeClient({
            server,
            trace,
            clientId: runtime.clientId,
            store: runtime.store,
          });
          activeClients[index] = restarted;
          trace.record("client.final_sync", { clientId: restarted.clientId });
          await restarted.client.start();
          await tick(8);
          await restarted.client.syncNow();
          await restarted.client.flushDrafts();
          await tick(8);
        }
      },
      assert: async ({ activeClients, serverStore, trace }) => {
        await assertProjectConvergence({
          serverStore,
          clients: activeClients,
          trace,
        });

        const serverIds = eventIds(await readCommittedEvents(serverStore));
        expect(serverIds).toContain("evt-alpha-lost-reply");
        expect(serverIds).toContain("evt-gamma-offline-1");
        expect(serverIds).toContain("evt-gamma-offline-2");
        expect(serverIds).toContain("evt-gamma-offline-during-sim");
      },
      cleanup: async ({ allClients = [] }) => {
        for (const runtime of allClients) {
          try {
            await runtime.client.stop();
          } catch {
            // best effort cleanup after simulation failure
          }
        }
      },
    });
  });
});

