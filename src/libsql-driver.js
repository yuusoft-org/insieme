const normalizeRow = (row, columns) => {
  if (row == null) return row;
  if (Array.isArray(row)) {
    /** @type {Record<string, unknown>} */
    const objectRow = {};
    for (let index = 0; index < columns.length; index += 1) {
      objectRow[columns[index]] = row[index];
    }
    return objectRow;
  }
  if (typeof row === "object") {
    return row;
  }
  return row;
};

export const parseIntSafe = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const createLibsqlDriver = (client) => {
  if (!client || typeof client.execute !== "function") {
    throw new Error(
      "libsql adapter requires a client with execute({ sql, args? })",
    );
  }

  const execute = async (sql, args = []) => {
    if (!Array.isArray(args)) {
      throw new Error("libsql execute args must be an array");
    }
    return client.execute(args.length > 0 ? { sql, args } : { sql });
  };

  const queryAll = async (sql, args = []) => {
    const result = await execute(sql, args);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const columns = Array.isArray(result?.columns) ? result.columns : [];
    return rows.map((row) => normalizeRow(row, columns));
  };

  const queryOne = async (sql, args = []) => {
    const rows = await queryAll(sql, args);
    return rows.length > 0 ? rows[0] : null;
  };

  const rowsAffected = (result) =>
    parseIntSafe(result?.rowsAffected ?? result?.changes ?? 0, 0);

  return {
    execute,
    queryAll,
    queryOne,
    rowsAffected,
  };
};
