import { describe, expect, it } from "vitest";
import {
  DEFAULT_WS_SERVER_OPTIONS,
  createWsServerOptions,
} from "../../../src/server.js";

describe("src createWsServerOptions", () => {
  it("applies recommended defaults for per-message deflate", () => {
    expect(createWsServerOptions({ maxPayload: 262_144 })).toEqual({
      noServer: true,
      maxPayload: 262_144,
      perMessageDeflate: {
        threshold: 256,
        concurrencyLimit: 10,
        zlibDeflateOptions: {
          level: 3,
          memLevel: 7,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
      },
    });
  });

  it("deep-merges per-message deflate overrides", () => {
    expect(
      createWsServerOptions({
        perMessageDeflate: {
          threshold: 512,
          serverNoContextTakeover: true,
          zlibDeflateOptions: {
            level: 1,
          },
          zlibInflateOptions: {
            chunkSize: 4 * 1024,
          },
        },
      }),
    ).toEqual({
      noServer: true,
      perMessageDeflate: {
        threshold: 512,
        concurrencyLimit: 10,
        serverNoContextTakeover: true,
        zlibDeflateOptions: {
          level: 1,
          memLevel: 7,
        },
        zlibInflateOptions: {
          chunkSize: 4 * 1024,
        },
      },
    });
  });

  it("supports disabling or fully replacing per-message deflate", () => {
    expect(createWsServerOptions({ perMessageDeflate: false })).toEqual({
      noServer: true,
      perMessageDeflate: false,
    });

    expect(createWsServerOptions({ perMessageDeflate: true })).toEqual({
      noServer: true,
      perMessageDeflate: true,
    });
  });

  it("returns fresh option objects without mutating defaults", () => {
    const first = createWsServerOptions();
    first.perMessageDeflate.threshold = 999;
    first.perMessageDeflate.zlibDeflateOptions.level = 9;

    const second = createWsServerOptions();

    expect(second).toEqual(DEFAULT_WS_SERVER_OPTIONS);
    expect(second.perMessageDeflate).not.toBe(first.perMessageDeflate);
    expect(second.perMessageDeflate.zlibDeflateOptions).not.toBe(
      first.perMessageDeflate.zlibDeflateOptions,
    );
  });
});
