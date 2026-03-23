import { isNonEmptyString, normalizeMeta, toPositiveIntegerOrNull } from "./event-record.js";

/**
 * Deterministically sorts object keys and recursively normalizes values.
 * Arrays preserve order.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export const deepSortKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => deepSortKeys(entry));
  }

  if (value && typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = {};
    for (const key of keys) {
      out[key] = deepSortKeys(obj[key]);
    }
    return out;
  }

  return value;
};

/**
 * @param {{
 *   partition?: string,
 *   projectId?: string,
 *   userId?: string,
 *   type?: string,
 *   schemaVersion?: number,
 *   payload?: object,
 *   meta?: object,
 * }} input
 * @returns {string}
 */
export const canonicalizeSubmitItem = ({
  partition,
  projectId,
  userId,
  type,
  schemaVersion,
  payload,
  meta,
}) => {
  const normalizedMeta = normalizeMeta(meta);
  delete normalizedMeta.clientId;

  const canonicalInput = {
    partition: isNonEmptyString(partition) ? partition : undefined,
    projectId: isNonEmptyString(projectId) ? projectId : undefined,
    userId: isNonEmptyString(userId) ? userId : undefined,
    type: isNonEmptyString(type) ? type : undefined,
    schemaVersion: toPositiveIntegerOrNull(schemaVersion) ?? undefined,
    payload: deepSortKeys(payload),
    meta: deepSortKeys(normalizedMeta),
  };
  return JSON.stringify(canonicalInput);
};
