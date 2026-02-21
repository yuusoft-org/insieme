import { reduceEvent } from "./reducer.js";

const cloneValue = (value) => {
  if (value === undefined) return undefined;
  return structuredClone(value);
};

const toStateFactory = (definition) => {
  if (typeof definition.initialState === "function") {
    return definition.initialState;
  }

  if (Object.prototype.hasOwnProperty.call(definition, "initialState")) {
    const seed = definition.initialState;
    return () => cloneValue(seed);
  }

  return () => undefined;
};

const normalizeVersion = (version) => {
  if (version === undefined) return "1";
  return String(version);
};

/**
 * @param {unknown} definitions
 * @returns {{ name: string, version: string, reduce: ({ state: unknown, event: object, partition: string }) => unknown, createInitialState: (partition: string) => unknown }[]}
 */
export const normalizeMaterializedViewDefinitions = (definitions) => {
  if (definitions === undefined || definitions === null) return [];
  if (!Array.isArray(definitions)) {
    throw new Error("materializedViews must be an array when provided");
  }

  const names = new Set();
  return definitions.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`materializedViews[${index}] must be an object`);
    }

    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw new Error(
        `materializedViews[${index}].name must be a non-empty string`,
      );
    }

    if (names.has(entry.name)) {
      throw new Error(
        `materializedViews contains duplicate name '${entry.name}'`,
      );
    }
    names.add(entry.name);

    const reduce = entry.reduce === undefined ? reduceEvent : entry.reduce;
    if (typeof reduce !== "function") {
      throw new Error(
        `materializedViews[${index}].reduce must be a function when provided`,
      );
    }

    return {
      name: entry.name,
      version: normalizeVersion(entry.version),
      reduce,
      createInitialState: toStateFactory(entry),
    };
  });
};

/**
 * @param {{ reduce: ({ state: unknown, event: object, partition: string }) => unknown }} definition
 * @param {unknown} state
 * @param {object} event
 * @param {string} partition
 * @returns {unknown}
 */
export const applyMaterializedViewReducer = (
  definition,
  state,
  event,
  partition,
) => {
  const next = definition.reduce({
    state,
    event,
    partition,
  });
  return next === undefined ? state : next;
};

/**
 * @param {{ createInitialState: (partition: string) => unknown }} definition
 * @param {string} partition
 * @returns {unknown}
 */
export const createMaterializedViewInitialState = (definition, partition) =>
  definition.createInitialState(partition);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export const cloneMaterializedViewValue = (value) => cloneValue(value);
