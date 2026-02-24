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

const defaultFallback = ({ event, payload }) => {
  const type = event?.event?.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("committed event is missing event.type");
  }

  if (type !== "event") {
    throw new Error(`unsupported committed event type '${type}'`);
  }

  if (!isObject(payload) || typeof payload.schema !== "string") {
    throw new Error("event payload must include a string schema");
  }

  throw new Error(`no schema handler registered for '${payload.schema}'`);
};

/**
 * Reducer factory for committed events.
 *
 * `schemaHandlers` are keyed by `event.payload.schema` when
 * `event.type === "event"`.
 * Handler args: `{ state, event, payload, partition, schema?, data? }`
 */
export const createReducer = ({
  schemaHandlers = {},
  fallback = defaultFallback,
} = {}) => {
  return ({ state, event, partition }) => {
    const type = event?.event?.type;
    const payload = event?.event?.payload;
    const baseContext = {
      event,
      payload,
      partition,
    };

    if (typeof type !== "string" || type.length === 0) {
      return runWithImmer({
        state,
        handler: fallback,
        context: baseContext,
      });
    }

    if (
      type === "event" &&
      isObject(payload) &&
      typeof payload.schema === "string"
    ) {
      const schemaHandler = schemaHandlers[payload.schema];
      if (typeof schemaHandler === "function") {
        return runWithImmer({
          state,
          handler: schemaHandler,
          context: {
            ...baseContext,
            schema: payload.schema,
            data: payload.data,
          },
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
