import { expect, test } from "vitest";
import { parseStoredSchemaVersion } from "../../../src/schema-version.js";

test.each([
  [1, 1], [2, 2], ["2", 2], [2n, 2], [999, 999],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  [BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
])("decodes stored version %s as the exact number %s", (stored, expected) => {
  expect(parseStoredSchemaVersion(stored)).toBe(expected);
});

test.each([
  undefined, null, true, false, {}, [], [2],
  0, -1, 2.9, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
  0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  "", "0", "-1", "2junk", "2.9", "2.0", "2e0", "0x2", "+2", "02",
  " 2", "2 ", "2\n", "2\r\n", "2\t", "NaN", "Infinity", "9007199254740993",
])("rejects malformed stored version %s without coercing or truncating it", (stored) => {
  expect(() => parseStoredSchemaVersion(stored)).toThrow(
    expect.objectContaining({ code: "invalid_schema_version" }),
  );
});
