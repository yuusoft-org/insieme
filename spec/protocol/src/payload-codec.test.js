import { describe, expect, it } from "vitest";
import {
  deserializePayload,
  serializePayload,
} from "../../../src/payload-codec.js";

describe("src payload-codec", () => {
  it("round-trips JSON payloads through binary storage", () => {
    const payload = { hello: "world", nested: { n: 1 } };
    expect(deserializePayload(serializePayload(payload))).toEqual(payload);
  });

  it("treats stringified byte arrays as plain JSON arrays", () => {
    const bytes = Array.from(serializePayload({ ok: true }));
    expect(deserializePayload(JSON.stringify(bytes))).toEqual(bytes);
  });

  it("does not reinterpret numeric-key JSON objects as byte payloads", () => {
    expect(deserializePayload('{"0":123,"1":125}')).toEqual({
      0: 123,
      1: 125,
    });
  });
});
