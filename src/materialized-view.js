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

const DEFAULT_CHECKPOINT_MODE = "immediate";
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_INTERVAL_MS = 1000;

const normalizePositiveInt = (value) => {
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
};

const normalizeCheckpoint = (checkpoint, index) => {
  if (checkpoint === undefined) {
    return {
      mode: DEFAULT_CHECKPOINT_MODE,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      intervalMs: DEFAULT_INTERVAL_MS,
      maxDirtyEvents: undefined,
    };
  }

  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error(
      `materializedViews[${index}].checkpoint must be an object when provided`,
    );
  }

  const mode = checkpoint.mode ?? DEFAULT_CHECKPOINT_MODE;
  if (
    mode !== "immediate" &&
    mode !== "manual" &&
    mode !== "debounce" &&
    mode !== "interval"
  ) {
    throw new Error(
      `materializedViews[${index}].checkpoint.mode must be immediate, manual, debounce, or interval`,
    );
  }

  return {
    mode,
    debounceMs:
      normalizePositiveInt(checkpoint.debounceMs) ?? DEFAULT_DEBOUNCE_MS,
    intervalMs:
      normalizePositiveInt(checkpoint.intervalMs) ?? DEFAULT_INTERVAL_MS,
    maxDirtyEvents: normalizePositiveInt(checkpoint.maxDirtyEvents),
  };
};

/**
 * @param {unknown} definitions
 * @returns {{ name: string, version: string, reduce: ({ state: unknown, event: object, partition: string }) => unknown, createInitialState: (partition: string) => unknown, matchesPartition: ({ loadedPartition: string, eventPartition: string, event: object }) => boolean }[]}
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

    if (typeof entry.reduce !== "function") {
      throw new Error(
        `materializedViews[${index}].reduce must be a function`,
      );
    }

    if (
      entry.matchPartition !== undefined &&
      typeof entry.matchPartition !== "function"
    ) {
      throw new Error(
        `materializedViews[${index}].matchPartition must be a function when provided`,
      );
    }

    return {
      name: entry.name,
      version: normalizeVersion(entry.version),
      reduce: entry.reduce,
      createInitialState: toStateFactory(entry),
      matchesPartition:
        typeof entry.matchPartition === "function"
          ? entry.matchPartition
          : ({ loadedPartition, eventPartition }) =>
              loadedPartition === eventPartition,
      checkpoint: normalizeCheckpoint(entry.checkpoint, index),
    };
  });
};

const toReducerEvent = (event) => {
  if (!event || typeof event !== "object") return event;
  if (event.event && typeof event.event === "object") {
    return event;
  }

  return {
    ...event,
    event: {
      type: event.type,
      payload: event.payload,
    },
  };
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
    event: toReducerEvent(event),
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
