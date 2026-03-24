import { describe, expect, it } from "vitest";
import * as root from "insieme";
import * as client from "insieme/client";
import * as browser from "insieme/browser";
import * as nodeEntrypoint from "insieme/node";
import * as server from "insieme/server";

const CLIENT_EXPORTS = [
  "commandToSyncEvent",
  "committedSyncEventToCommand",
  "createBrowserWebSocketTransport",
  "createCommandSyncSession",
  "createIndexedDBClientStore",
  "createInMemoryClientStore",
  "createIndexedDbClientStore",
  "createLibsqlClientStore",
  "createMaterializedViewRuntime",
  "createOfflineTransport",
  "createReducer",
  "createSyncClient",
  "validateCommandSubmitItem",
].sort();

const NODE_EXPORTS = [
  ...CLIENT_EXPORTS,
  "attachWsConnection",
  "createInMemorySyncStore",
  "createLibsqlSyncStore",
  "createSqliteClientStore",
  "createSqliteSyncStore",
  "createSyncServer",
  "createWsServerRuntime",
].sort();

describe("package exports", () => {
  it("publishes only the supported client surface", () => {
    expect(Object.keys(root).sort()).toEqual(CLIENT_EXPORTS);
    expect(Object.keys(client).sort()).toEqual(CLIENT_EXPORTS);
    expect(Object.keys(browser).sort()).toEqual(CLIENT_EXPORTS);
  });

  it("publishes only the supported node surface", () => {
    expect(Object.keys(nodeEntrypoint).sort()).toEqual(NODE_EXPORTS);
    expect(Object.keys(server).sort()).toEqual(NODE_EXPORTS);
  });
});
