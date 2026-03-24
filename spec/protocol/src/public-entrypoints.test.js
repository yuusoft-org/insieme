import { describe, expect, it } from "vitest";
import * as client from "../../../src/client.js";
import * as browser from "../../../src/browser.js";
import * as nodeEntrypoint from "../../../src/node.js";
import * as server from "../../../src/server.js";
import { createSyncClient } from "../../../src/sync-client.js";
import { createSyncServer } from "../../../src/sync-server.js";
import { createReducer } from "../../../src/reducer.js";
import { createMaterializedViewRuntime } from "../../../src/materialized-view-runtime.js";
import { createIndexedDbClientStore } from "../../../src/indexeddb-client-store.js";
import { createLibsqlClientStore } from "../../../src/libsql-client-store.js";

describe("public entrypoints", () => {
  it("exports client helpers from the client entrypoint", () => {
    expect(client.createSyncClient).toBe(createSyncClient);
    expect(client.createReducer).toBe(createReducer);
    expect(client.createMaterializedViewRuntime).toBe(
      createMaterializedViewRuntime,
    );
    expect(client.createIndexedDbClientStore).toBe(createIndexedDbClientStore);
    expect(client.createLibsqlClientStore).toBe(createLibsqlClientStore);
  });

  it("re-exports the client surface from the browser entrypoint", () => {
    expect(browser.createSyncClient).toBe(client.createSyncClient);
    expect(browser.createReducer).toBe(client.createReducer);
    expect(browser.createMaterializedViewRuntime).toBe(
      client.createMaterializedViewRuntime,
    );
    expect(browser.createLibsqlClientStore).toBe(client.createLibsqlClientStore);
  });

  it("exports server and shared helpers from the server entrypoint", () => {
    expect(server.createSyncServer).toBe(createSyncServer);
    expect(server.createReducer).toBe(createReducer);
    expect(server.createIndexedDbClientStore).toBe(createIndexedDbClientStore);
  });

  it("re-exports the server surface from the node entrypoint", () => {
    expect(nodeEntrypoint.createSyncServer).toBe(server.createSyncServer);
    expect(nodeEntrypoint.createSqliteClientStore).toBe(
      server.createSqliteClientStore,
    );
    expect(nodeEntrypoint.createReducer).toBe(server.createReducer);
  });
});
