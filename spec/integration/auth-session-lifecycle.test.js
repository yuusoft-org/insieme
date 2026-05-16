import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Authentication and authorization enforcement.
 * Tests token verification, project authorization, and session validation.
 */
describe("integration auth-session-lifecycle", () => {
  it("rejects a connection with an invalid token", async () => {
    const { server } = createTestServer({
      verifyToken: async (token) => {
        if (token === "bad-token") throw new Error("invalid");
        return { clientId: "C1", claims: {} };
      },
    });

    const { client, transport } = createTestClient({
      server,
      clientId: "C1",
    });

    // Client start sends connect with token="C1" by default in createTestClient.
    // We need a client that sends a bad token.
    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );

    const badTransport = createLoopbackTransport({
      server,
      connectionId: "conn-bad",
    });
    const badClient = createSyncClient({
      transport: badTransport,
      store: transport.getSentMessages
        ? undefined
        : undefined,
      token: "bad-token",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => "evt-bad-1",
    });

    // Need to provide a store - use the one from createTestClient
    // Actually let's just use the full createTestClient but override token via manual construction
    const { createInMemoryClientStore } = await import(
      "../../src/in-memory-client-store.js"
    );
    const store = createInMemoryClientStore();

    const badClient2 = createSyncClient({
      transport: badTransport,
      store,
      token: "bad-token",
      clientId: "C1",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => "evt-bad-1",
    });

    await badClient2.start();
    await tick();
    await tick();

    expect(badTransport.isConnected()).toBe(false);
  });

  it("rejects a connection when clientId mismatches token identity", async () => {
    const { server } = createTestServer({
      verifyToken: async () => ({
        clientId: "real-client",
        claims: {},
      }),
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );
    const { createInMemoryClientStore } = await import(
      "../../src/in-memory-client-store.js"
    );

    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-mismatch",
    });
    const client = createSyncClient({
      transport,
      store: createInMemoryClientStore(),
      token: "valid-token",
      clientId: "impostor",
      projectId: "proj-1",
      now: () => Date.now(),
      uuid: () => "evt-mismatch-1",
    });

    await client.start();
    await tick();
    await tick();

    expect(transport.isConnected()).toBe(false);
  });

  it("accepts a valid token and authorized project", async () => {
    const { server } = createTestServer({
      verifyToken: async (token) => ({ clientId: token, claims: {} }),
      authorize: async (identity, projectId) => projectId === "proj-1",
    });

    const { client, transport } = createTestClient({
      server,
      clientId: "C1",
      projectId: "proj-1",
    });

    await client.start();
    await tick();

    expect(transport.isConnected()).toBe(true);

    await client.stop();
  });

  it("session can be invalidated mid-stream", async () => {
    let sessionValid = true;
    const { server } = createTestServer({
      verifyToken: async (token) => ({ clientId: token, claims: {} }),
      validateSession: async () => sessionValid,
    });

    const { client, transport } = createTestClient({
      server,
      clientId: "C1",
    });

    await client.start();
    await tick();

    expect(transport.isConnected()).toBe(true);

    sessionValid = false;

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { n: 1 },
    });
    await tick();

    expect(transport.isConnected()).toBe(false);
  });

  it("unauthorized project access is denied on connect", async () => {
    const { server } = createTestServer({
      authorize: async (identity, projectId) => projectId === "allowed-proj",
    });

    const { createSyncClient } = await import("../../src/sync-client.js");
    const { createLoopbackTransport } = await import(
      "../harness/create-loopback-transport.js"
    );
    const { createInMemoryClientStore } = await import(
      "../../src/in-memory-client-store.js"
    );

    const transport = createLoopbackTransport({
      server,
      connectionId: "conn-denied",
    });
    const client = createSyncClient({
      transport,
      store: createInMemoryClientStore(),
      token: "C1",
      clientId: "C1",
      projectId: "denied-proj",
      now: () => Date.now(),
      uuid: () => "evt-denied-1",
    });

    await client.start();
    await tick();
    await tick();

    // Server should have sent a forbidden error message
    const received = transport.getReceivedMessages();
    const forbidden = received.find(
      (m) => m.type === "error" && m.payload?.code === "forbidden",
    );
    expect(forbidden).toBeTruthy();
    expect(forbidden.payload.message).toBe("project access denied");
  });
});
