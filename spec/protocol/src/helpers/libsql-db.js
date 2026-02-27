import { createSqliteDb, hasNodeSqlite } from "./sqlite-db.js";

const normalizeStatement = (statement) => {
  if (typeof statement === "string") {
    return { sql: statement, args: [] };
  }
  if (!statement || typeof statement.sql !== "string") {
    throw new Error("libsql test client requires execute({ sql, args? })");
  }
  return {
    sql: statement.sql,
    args: Array.isArray(statement.args) ? statement.args : [],
  };
};

const shouldFetchRows = (sql) => {
  const trimmed = sql.trim().toUpperCase();
  return (
    trimmed.startsWith("SELECT") ||
    trimmed.startsWith("PRAGMA") ||
    trimmed.startsWith("WITH")
  );
};

export const createLibsqlClient = (location = ":memory:") => {
  const db = createSqliteDb(location);

  return {
    execute: async (statement) => {
      const { sql, args } = normalizeStatement(statement);
      const prepared = db._raw.prepare(sql);

      if (shouldFetchRows(sql)) {
        const rows = prepared.all(...args);
        const columns = prepared.columns().map((column) => column.name);
        return {
          rows,
          columns,
          rowsAffected: 0,
        };
      }

      const runResult = prepared.run(...args);
      return {
        rows: [],
        columns: [],
        rowsAffected: runResult.changes,
        lastInsertRowid: runResult.lastInsertRowid,
      };
    },
    close: () => db.close(),
    _raw: db._raw,
  };
};

export const hasNodeLibsqlShim = hasNodeSqlite;
