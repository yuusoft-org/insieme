import { produce } from "immer";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeStateRoot = (state) => (isObject(state) ? state : {});

const runWithImmer = ({ state, handler, context }) =>
  produce(normalizeStateRoot(state), (draft) => {
    const next = handler({ ...context, state: draft });
    if (next !== undefined) return next;
    return undefined;
  });

const resolveEventEnvelope = (eventRecord) => {
  if (isObject(eventRecord?.event)) {
    return eventRecord.event;
  }
  return eventRecord;
};

const defaultFallback = ({ type }) => {
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("committed event is missing type");
  }

  throw new Error(`no handler registered for '${type}'`);
};

/**
 * Reducer factory for committed events.
 *
 * Handlers are keyed by committed-event `type`.
 * Handler args: `{ state, event, payload, partition, type }`
 */
export const createReducer = ({
  schemaHandlers = {},
  fallback = defaultFallback,
} = {}) => {
  return ({ state, event, partition }) => {
    const envelope = resolveEventEnvelope(event);
    const type = envelope?.type;
    const payload = envelope?.payload;
    const baseContext = {
      event,
      payload,
      partition,
      type,
    };

    if (typeof type === "string" && type.length > 0) {
      const schemaHandler = schemaHandlers[type];
      if (typeof schemaHandler === "function") {
        return runWithImmer({
          state,
          handler: schemaHandler,
          context: baseContext,
        });
      }
    }

    return runWithImmer({
      state,
      handler: fallback,
      context: baseContext,
    });
  };
};
