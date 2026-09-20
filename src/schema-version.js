/** JSON events must carry an exact, positive, safe integer number. */
export const validateNewSchemaVersion = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    const error = new Error("schemaVersion must be a positive safe integer");
    error.code = "invalid_schema_version";
    throw error;
  }
};

/** Decode integer representations returned by storage without partial parsing. */
export const parseStoredSchemaVersion = (value) => {
  let version = value;
  if (typeof value === "bigint" || typeof value === "string") {
    version = Number(value);
    // Require the exact decimal representation, not whitespace or partial input.
    if (typeof value === "string" && String(version) !== value) version = NaN;
  }
  validateNewSchemaVersion(version);
  return version;
};
