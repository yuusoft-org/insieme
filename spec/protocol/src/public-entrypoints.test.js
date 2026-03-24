import { describe, expect, it } from "vitest";
import * as client from "../../../src/client.js";
import * as browser from "../../../src/browser.js";
import * as nodeEntrypoint from "../../../src/node.js";
import * as server from "../../../src/server.js";
import { createSyncClient } from "../../../src/sync-client.js";
import { createSyncServer } from "../../../src/sync-server.js";
import { createReducer } from "../../../src/reducer.js";
import { createIndexedDbClientStore } from "../../../src/indexeddb-client-store.js";
import { createLibsqlClientStore } from "../../../src/libsql-client-store.js";
import { createOfflineTransport } from "../../../src/offline-transport.js";
import { createBrowserWebSocketTransport } from "../../../src/browser-websocket-transport.js";
import { createInMemoryClientStore } from "../../../src/in-memory-client-store.js";
import { createInMemorySyncStore } from "../../../src/in-memory-sync-store.js";
import { createSqliteClientStore } from "../../../src/sqlite-client-store.js";
import { createSqliteSyncStore } from "../../../src/sqlite-sync-store.js";
import { createLibsqlSyncStore } from "../../../src/libsql-sync-store.js";
import { attachWsConnection } from "../../../src/ws-server-bridge.js";
import { createWsServerRuntime } from "../../../src/ws-server-runtime.js";

const CLIENT_EXPORTS = [
  "createBrowserWebSocketTransport",
  "createInMemoryClientStore",
  "createIndexedDbClientStore",
  "createLibsqlClientStore",
  "createOfflineTransport",
  "createReducer",
  "createSyncClient",
].sort();

const SERVER_EXPORTS = [
  ...CLIENT_EXPORTS,
  "attachWsConnection",
  "createInMemorySyncStore",
  "createLibsqlSyncStore",
  "createSqliteClientStore",
  "createSqliteSyncStore",
  "createSyncServer",
  "createWsServerRuntime",
].sort();

describe("public entrypoints", () => {
  it("exports only the supported client helpers from the client entrypoint", () => {
    expect(Object.keys(client).sort()).toEqual(CLIENT_EXPORTS);
    expect(client.createSyncClient).toBe(createSyncClient);
    expect(client.createOfflineTransport).toBe(createOfflineTransport);
    expect(client.createBrowserWebSocketTransport).toBe(
      createBrowserWebSocketTransport,
    );
    expect(client.createInMemoryClientStore).toBe(createInMemoryClientStore);
    expect(client.createReducer).toBe(createReducer);
    expect(client.createIndexedDbClientStore).toBe(createIndexedDbClientStore);
    expect(client.createLibsqlClientStore).toBe(createLibsqlClientStore);
  });

  it("re-exports the client surface from the browser entrypoint", () => {
    expect(Object.keys(browser).sort()).toEqual(CLIENT_EXPORTS);
    expect(browser.createSyncClient).toBe(client.createSyncClient);
    expect(browser.createReducer).toBe(client.createReducer);
    expect(browser.createOfflineTransport).toBe(client.createOfflineTransport);
    expect(browser.createLibsqlClientStore).toBe(client.createLibsqlClientStore);
  });

  it("exports only the supported server and shared helpers from the server entrypoint", () => {
    expect(Object.keys(server).sort()).toEqual(SERVER_EXPORTS);
    expect(server.createSyncServer).toBe(createSyncServer);
    expect(server.createInMemorySyncStore).toBe(createInMemorySyncStore);
    expect(server.createSqliteClientStore).toBe(createSqliteClientStore);
    expect(server.createSqliteSyncStore).toBe(createSqliteSyncStore);
    expect(server.createLibsqlSyncStore).toBe(createLibsqlSyncStore);
    expect(server.attachWsConnection).toBe(attachWsConnection);
    expect(server.createWsServerRuntime).toBe(createWsServerRuntime);
    expect(server.createReducer).toBe(createReducer);
    expect(server.createIndexedDbClientStore).toBe(createIndexedDbClientStore);
  });

  it("re-exports the server surface from the node entrypoint", () => {
    expect(Object.keys(nodeEntrypoint).sort()).toEqual(SERVER_EXPORTS);
    expect(nodeEntrypoint.createSyncServer).toBe(server.createSyncServer);
    expect(nodeEntrypoint.createSqliteClientStore).toBe(
      server.createSqliteClientStore,
    );
    expect(nodeEntrypoint.createReducer).toBe(server.createReducer);
  });
});
