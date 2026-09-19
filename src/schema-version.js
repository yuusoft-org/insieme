/** Retain the driver's value alongside the historical numeric interpretation. */
export const attachRawSchemaVersion = (record, raw, include) => {
  if (include) record.rawSchemaVersion = raw;
  return record;
};

/** Newly authored JSON events must carry an exact, positive, safe integer. */
export const validateNewSchemaVersion = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    const error = new Error("schemaVersion must be a positive safe integer");
    error.code = "invalid_schema_version";
    throw error;
  }
};
