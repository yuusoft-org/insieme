import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json" with { type: "json" };
import * as root from "insieme";
import * as client from "insieme/client";
import * as browser from "insieme/browser";
import * as nodeEntrypoint from "insieme/node";
import * as server from "insieme/server";

const CLIENT_EXPORTS = [
  "commandToSyncEvent",
  "committedSyncEventToCommand",
  "createBrowserWebSocketTransport",
  "createAsyncSqliteClientStore",
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tscBin = resolve(packageRoot, "node_modules/typescript/bin/tsc");

function collectDeclaredTypePaths() {
  const typePaths = new Set();

  if (packageJson.types) {
    typePaths.add(packageJson.types);
  }

  for (const exportConfig of Object.values(packageJson.exports)) {
    if (exportConfig && typeof exportConfig === "object" && exportConfig.types) {
      typePaths.add(exportConfig.types);
    }
  }

  return [...typePaths].sort();
}

describe("package exports", () => {
  it("publishes existing declaration files for every declared types condition", () => {
    expect(collectDeclaredTypePaths()).toEqual([
      "./types/browser.d.ts",
      "./types/client.d.ts",
      "./types/node.d.ts",
      "./types/server.d.ts",
    ]);

    for (const typePath of collectDeclaredTypePaths()) {
      expect(existsSync(resolve(packageRoot, typePath)), typePath).toBe(true);
    }
  });

  it("publishes NodeNext-compatible declarations for package consumers", () => {
    const tempDir = mkdtempSync(join(os.tmpdir(), "insieme-types-consumer-"));
    try {
      const nodeModulesDir = join(tempDir, "node_modules");
      mkdirSync(nodeModulesDir, { recursive: true });
      symlinkSync(packageRoot, join(nodeModulesDir, "insieme"), "dir");
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              target: "ES2022",
              skipLibCheck: false,
            },
            include: ["index.ts"],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tempDir, "index.ts"),
        [
          'import { createSyncClient } from "insieme";',
          'import { createSyncServer } from "insieme/server";',
          'import { createSqliteSyncStore } from "insieme/node";',
          'import { createBrowserWebSocketTransport } from "insieme/browser";',
          "void createSyncClient;",
          "void createSyncServer;",
          "void createSqliteSyncStore;",
          "void createBrowserWebSocketTransport;",
        ].join("\n"),
      );

      execFileSync(process.execPath, [tscBin, "--noEmit", "-p", tempDir], {
        cwd: tempDir,
        stdio: "pipe",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
