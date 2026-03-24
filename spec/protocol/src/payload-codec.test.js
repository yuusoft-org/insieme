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

  it("deserializes ArrayBuffer and generic ArrayBuffer views", () => {
    const payload = { ok: true, nested: { n: 1 } };
    const bytes = Uint8Array.from(serializePayload(payload));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );

    expect(deserializePayload(buffer)).toEqual(payload);
    expect(deserializePayload(new DataView(buffer))).toEqual(payload);
  });

  it("deserializes serialized byte container variants", () => {
    const payload = { ok: true };
    const bytes = Array.from(serializePayload(payload));
    const indexedBytes = Object.fromEntries(bytes.map((value, index) => [index, value]));

    expect(
      deserializePayload({
        type: "Buffer",
        data: bytes,
      }),
    ).toEqual(payload);
    expect(
      deserializePayload({
        bytes,
      }),
    ).toEqual(payload);
    expect(deserializePayload(indexedBytes)).toEqual(payload);
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

  it("rejects undefined and invalid non-byte payload inputs", () => {
    expect(() => serializePayload(undefined)).toThrow(
      "payload must be JSON-serializable",
    );
    expect(() => deserializePayload({ bytes: [300] })).toThrow(
      "payload must be stored as text or bytes",
    );
  });
});
