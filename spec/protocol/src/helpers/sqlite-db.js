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

export const createAsyncSqliteDriver = (location = ":memory:") => {
  if (!hasNodeSqlite) {
    throw new Error("node:sqlite is not available in this Node runtime");
  }

  const raw = new DatabaseSync(location);
  let txDepth = 0;
  let closed = false;
  let writeTail = Promise.resolve();

  const assertOpen = () => {
    if (!closed) return;
    const error = new Error("async sqlite test driver is closed");
    error.code = "driver_closed";
    throw error;
  };

  const runTransaction = async (mode, run) => {
    assertOpen();
    const outer = txDepth === 0;
    const savepoint = `sp_${txDepth + 1}`;
    txDepth += 1;

    if (outer) {
      raw.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    } else {
      raw.exec(`SAVEPOINT ${savepoint}`);
    }

    const tx = {
      query: async (sql, args = []) => {
        assertOpen();
        return raw.prepare(sql).all(...args);
      },
      execute: async (sql, args = []) => {
        assertOpen();
        const result = raw.prepare(sql).run(...args);
        return {
          rowsAffected: result.changes,
          lastInsertRowId: result.lastInsertRowid,
        };
      },
    };

    try {
      const result = await run(tx);
      if (outer) {
        raw.exec("COMMIT");
      } else {
        raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      if (outer) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // best-effort rollback
        }
      } else {
        try {
          raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
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
    init: async () => {
      assertOpen();
    },
    transaction: async (mode, run) => {
      if (mode === "write") {
        const operation = writeTail.catch(() => {}).then(() => runTransaction(mode, run));
        writeTail = operation.catch(() => {});
        return operation;
      }
      return runTransaction(mode, run);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await writeTail.catch(() => {});
      raw.close();
    },
    _raw: raw,
  };
};
