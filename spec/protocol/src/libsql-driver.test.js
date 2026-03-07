import { describe, expect, it, vi } from "vitest";
import { createLibsqlDriver, parseIntSafe } from "../../../src/libsql-driver.js";

describe("src libsql-driver", () => {
  it("validates clients and execute args", async () => {
    expect(() => createLibsqlDriver()).toThrow(
      "libsql adapter requires a client with execute({ sql, args? })",
    );

    const driver = createLibsqlDriver({
      execute: async () => ({ rows: [], columns: [] }),
    });

    await expect(driver.execute("SELECT 1", "bad")).rejects.toThrow(
      "libsql execute args must be an array",
    );
  });

  it("normalizes query rows and argument forwarding", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [[1, "Alice"]],
        columns: ["id", "name"],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 2, name: "Bob" }],
        columns: ["id", "name"],
      })
      .mockResolvedValueOnce({
        rows: [7],
        columns: ["value"],
      })
      .mockResolvedValueOnce({
        rows: [],
        columns: ["id"],
      });
    const driver = createLibsqlDriver({ execute });

    expect(await driver.queryAll("SELECT * FROM users WHERE id = ?", [1])).toEqual(
      [{ id: 1, name: "Alice" }],
    );
    expect(await driver.queryAll("SELECT * FROM users")).toEqual([
      { id: 2, name: "Bob" },
    ]);
    expect(await driver.queryAll("SELECT 7")).toEqual([7]);
    expect(await driver.queryOne("SELECT * FROM users WHERE id = ?", [99])).toBe(
      null,
    );

    expect(execute).toHaveBeenNthCalledWith(1, {
      sql: "SELECT * FROM users WHERE id = ?",
      args: [1],
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      sql: "SELECT * FROM users",
    });
    expect(execute).toHaveBeenNthCalledWith(3, {
      sql: "SELECT 7",
    });
  });

  it("parses integer values and rowsAffected fallbacks", () => {
    expect(parseIntSafe(undefined, 5)).toBe(5);
    expect(parseIntSafe(null, 6)).toBe(6);
    expect(parseIntSafe(8n, 0)).toBe(8);
    expect(parseIntSafe("12", 0)).toBe(12);
    expect(parseIntSafe("bad", 9)).toBe(9);

    const driver = createLibsqlDriver({
      execute: async () => ({ rows: [], columns: [] }),
    });

    expect(driver.rowsAffected({ rowsAffected: "3" })).toBe(3);
    expect(driver.rowsAffected({ changes: 4n })).toBe(4);
    expect(driver.rowsAffected({})).toBe(0);
  });
});
