import { describe, expect, it } from "vitest";
import {
  createInMemoryClientStore,
  createSyncClient,
} from "../../src/index.js";
import { createTestServer } from "../harness/create-test-server.js";
import { createFaultTransport } from "../harness/fault-transport.js";
import {
  assertClientServerConverged,
  assertCommittedEventIds,
  assertNoDrafts,
} from "../harness/history-checker.js";
import { runScenario } from "../harness/scenario-runner.js";

const makeClient = ({
  server,
  store = createInMemoryClientStore(),
  clientId = "C1",
  projectId = "proj-1",
  transport,
  uuid = () => "evt-scenario-harness",
}) => {
  let nowValue = 20_000;
  const runtimeTransport =
    transport ||
    createFaultTransport({
      server,
      connectionId: `conn-${clientId}`,
    });
  const client = createSyncClient({
    transport: runtimeTransport,
    store,
    token: clientId,
    clientId,
    projectId,
    now: () => {
      nowValue += 1;
      return nowValue;
    },
    uuid,
    reconnect: { enabled: false },
  });
  return { client, store, transport: runtimeTransport };
};

describe("scenario harness", () => {
  it("records and checks lost submit-result recovery with deterministic faults", async () => {
    await runScenario("scenario harness lost submit result recovery", {
      seed: 20260523,
      setup: ({ trace }) => {
        const { server, store: serverStore } = createTestServer();
        const clientStore = createInMemoryClientStore();
        const transport = createFaultTransport({
          server,
          connectionId: "conn-scenario-lost-result",
          trace,
          faults: [
            {
              name: "drop-first-submit-result",
              direction: "server_to_client",
              type: "submit_events_result",
              once: true,
            },
          ],
        });
        const { client } = makeClient({
          server,
          store: clientStore,
          transport,
          uuid: () => "evt-scenario-lost-result",
        });
        return {
          server,
          serverStore,
          clientStore,
          transport,
          client,
        };
      },
      run: async (context) => {
        const { client, clientStore, server, serverStore, tick, trace, transport } =
          context;

        trace.record("client.start", { clientId: "C1" });
        await client.start();
        await tick(2);

        trace.record("client.submit", { id: "evt-scenario-lost-result" });
        await client.submitEvent({
          partition: "docs",
          type: "doc.updated",
          schemaVersion: 1,
          payload: { title: "Durable commit with lost reply" },
        });
        await tick(2);

        expect(transport.getDroppedMessages().map((message) => message.type)).toEqual([
          "submit_events_result",
        ]);
        await assertCommittedEventIds({
          store: serverStore,
          ids: ["evt-scenario-lost-result"],
          label: "server",
          trace,
        });
        expect(clientStore._debug.getDrafts().map((draft) => draft.id)).toEqual([
          "evt-scenario-lost-result",
        ]);

        await client.stop();

        const restartedTransport = createFaultTransport({
          server,
          connectionId: "conn-scenario-lost-result-restart",
          trace,
        });
        const restarted = makeClient({
          server,
          store: clientStore,
          transport: restartedTransport,
          uuid: () => "evt-unused",
        });
        context.restartedClient = restarted.client;

        trace.record("client.restart", { clientId: "C1" });
        await restarted.client.start();
        await tick(3);
        await restarted.client.stop();
      },
      assert: async ({ clientStore, serverStore, trace }) => {
        await assertClientServerConverged({
          serverStore,
          clientStore,
          trace,
        });
        await assertNoDrafts({
          store: clientStore,
          trace,
        });
      },
      cleanup: async ({ client, restartedClient }) => {
        try {
          await client?.stop?.();
        } catch {
          // best effort cleanup after scenario failure
        }
        try {
          await restartedClient?.stop?.();
        } catch {
          // best effort cleanup after scenario failure
        }
      },
    });
  });
});

