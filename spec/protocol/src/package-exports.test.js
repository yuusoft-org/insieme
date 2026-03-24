import { describe, expect, it } from "vitest";
import * as root from "insieme";
import * as client from "insieme/client";
import * as browser from "insieme/browser";
import * as nodeEntrypoint from "insieme/node";
import * as server from "insieme/server";

describe("package exports", () => {
  it("keeps the root, client, and browser entrypoints aligned", () => {
    expect(Object.keys(root).sort()).toEqual(Object.keys(client).sort());
    expect(Object.keys(browser).sort()).toEqual(Object.keys(client).sort());
    expect(root.createSyncClient).toBe(client.createSyncClient);
    expect(browser.createOfflineTransport).toBe(client.createOfflineTransport);
  });

  it("does not leak node-only helpers into the portable client surface", () => {
    expect("createSyncServer" in root).toBe(false);
    expect("createSqliteClientStore" in root).toBe(false);
    expect("createSqliteSyncStore" in root).toBe(false);
    expect("createInMemorySyncStore" in root).toBe(false);
    expect("authorizeProjectId" in root).toBe(false);
  });

  it("keeps the node and server entrypoints aligned", () => {
    expect(Object.keys(nodeEntrypoint).sort()).toEqual(
      Object.keys(server).sort(),
    );
    expect(nodeEntrypoint.createSyncServer).toBe(server.createSyncServer);
    expect(nodeEntrypoint.createSqliteClientStore).toBe(
      server.createSqliteClientStore,
    );
    expect(nodeEntrypoint.createSqliteSyncStore).toBe(
      server.createSqliteSyncStore,
    );
    expect(nodeEntrypoint.authorizeProjectId).toBe(server.authorizeProjectId);
  });
});
