import { describe, expect, it } from "vitest";
import { createTestServer } from "../harness/create-test-server.js";
import { createTestClient } from "../harness/create-test-client.js";
import { tick } from "../harness/event-helpers.js";

/**
 * Integration: Server-side validation and rejection scenarios.
 * Tests that the server's validation layer rejects invalid events
 * and the client correctly handles rejected submissions.
 */
describe("integration validation-rejection", () => {
  it("server rejects an event that fails validation", async () => {
    const { server } = createTestServer({
      validate: async (item) => {
        if (!item.payload || !item.payload.required) {
          const error = new Error("missing required field");
          error.code = "validation_failed";
          throw error;
        }
      },
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { required: false },
    });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(0);
    expect(store._debug.getDrafts()).toHaveLength(0);

    await client.stop();
  });

  it("local validation gate prevents drafts from reaching server", async () => {
    const { server } = createTestServer();

    const { client, store } = createTestClient({
      server,
      clientId: "C1",
      validateLocalEvent: (item) => {
        if (!item.payload?.allowed) {
          const error = new Error("local validation rejected");
          error.code = "validation_failed";
          throw error;
        }
      },
    });

    await client.start();
    await tick();

    await expect(
      client.submitEvent({
        partition: "data",
        type: "item",
        schemaVersion: 1,
        payload: { allowed: false },
      }),
    ).rejects.toThrow("local validation rejected");

    expect(store._debug.getDrafts()).toHaveLength(0);

    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { allowed: true },
    });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(1);

    await client.stop();
  });

  it("server validates each event independently", async () => {
    let validateCallCount = 0;
    const { server } = createTestServer({
      validate: async (item) => {
        validateCallCount += 1;
        if (item.payload?.reject) {
          const error = new Error("rejected");
          error.code = "validation_failed";
          throw error;
        }
      },
    });

    const { client, store } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    // Submit valid event
    await client.submitEvent({
      partition: "data",
      type: "item",
      schemaVersion: 1,
      payload: { reject: false, seq: 1 },
    });
    await tick();

    expect(store._debug.getCommitted()).toHaveLength(1);

    await client.stop();
  });

  it("events that pass validation are committed to server store", async () => {
    const { server, store: serverStore } = createTestServer({
      validate: async (item) => {
        if (!item.type || item.type === "invalid_type") {
          const error = new Error("bad type");
          error.code = "validation_failed";
          throw error;
        }
      },
    });

    const { client } = createTestClient({ server, clientId: "C1" });

    await client.start();
    await tick();

    await client.submitEvent({
      partition: "data",
      type: "valid_type",
      schemaVersion: 1,
      payload: { value: 42 },
    });
    await tick();

    const serverCommitted = serverStore._debug.getCommitted();
    expect(serverCommitted).toHaveLength(1);
    expect(serverCommitted[0].type).toBe("valid_type");

    await client.stop();
  });
});
