let DatabaseSync = null;
try {
  // Node >=22 provides node:sqlite (still experimental in some releases).
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const hasNodeSqlite = typeof DatabaseSync === "function";

export const createSqliteDb = (location = ":memory:") => {
  if (!hasNodeSqlite) {
    throw new Error("node:sqlite is not available in this Node runtime");
  }
  const raw = new DatabaseSync(location);
  let txDepth = 0;

  const exec = (sql) => raw.exec(sql);

  const prepare = (sql) => {
    const stmt = raw.prepare(sql);
    return {
      run: (params = {}) => stmt.run(params),
      get: (params = {}) => stmt.get(params),
      all: (params = {}) => stmt.all(params),
    };
  };

  const transaction = (fn) => (arg) => {
    const outer = txDepth === 0;
    const savepoint = `sp_${txDepth + 1}`;
    txDepth += 1;

    if (outer) {
      exec("BEGIN IMMEDIATE");
    } else {
      exec(`SAVEPOINT ${savepoint}`);
    }

    try {
      const result = fn(arg);
      if (outer) {
        exec("COMMIT");
      } else {
        exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      if (outer) {
        try {
          exec("ROLLBACK");
        } catch {
          // best-effort rollback
        }
      } else {
        try {
          exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // best-effort rollback to savepoint
        }
      }
      throw error;
    } finally {
      txDepth -= 1;
    }
  };

  return {
    exec,
    prepare,
    transaction,
    close: () => raw.close(),
    _raw: raw,
  };
};
