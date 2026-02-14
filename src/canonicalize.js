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
 * @param {string[]} partitions
 * @returns {string[]}
 */
export const normalizePartitionSet = (partitions) => {
  const sorted = [...partitions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const unique = [];
  for (const value of sorted) {
    if (unique.length === 0 || unique[unique.length - 1] !== value) {
      unique.push(value);
    }
  }
  return unique;
};

/**
 * @param {{ partitions: string[], event: object }} input
 * @returns {string}
 */
export const canonicalizeSubmitItem = ({ partitions, event }) => {
  const canonicalInput = {
    partitions: normalizePartitionSet(partitions),
    event: deepSortKeys(event),
  };
  return JSON.stringify(canonicalInput);
};

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
export const intersectsPartitions = (left, right) => {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  for (const value of left) {
    if (rightSet.has(value)) return true;
  }
  return false;
};
