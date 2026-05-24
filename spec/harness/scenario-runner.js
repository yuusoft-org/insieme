import { tickN } from "./event-helpers.js";

const DEFAULT_TRACE_TAIL = 20;

const formatTraceEvent = (event) =>
  JSON.stringify({
    tick: event.tick,
    kind: event.kind,
    detail: event.detail,
  });

export const createScenarioTrace = ({ name, seed }) => {
  let logicalTick = 0;
  const events = [];

  return {
    get tick() {
      return logicalTick;
    },
    advance: (count = 1) => {
      logicalTick += count;
      return logicalTick;
    },
    record: (kind, detail = {}) => {
      events.push({
        tick: logicalTick,
        kind,
        detail: structuredClone(detail),
      });
    },
    events: () => [...events],
    tail: (count = DEFAULT_TRACE_TAIL) => events.slice(-count),
    formatFailure: ({ invariant, cause } = {}) => {
      const lines = [
        `SCENARIO ${name}`,
        `SEED ${seed}`,
        `TICK ${logicalTick}`,
      ];
      if (invariant) lines.push(`INVARIANT ${invariant}`);
      if (cause) lines.push(`CAUSE ${cause}`);
      lines.push(`REPLAY bunx vitest --run --testNamePattern="${name}"`);
      lines.push("TRACE");
      for (const event of events.slice(-DEFAULT_TRACE_TAIL)) {
        lines.push(formatTraceEvent(event));
      }
      return lines.join("\n");
    },
  };
};

export const runScenario = async (
  name,
  {
    seed = 1,
    setup,
    run,
    assert,
    cleanup,
    traceTail = DEFAULT_TRACE_TAIL,
  } = {},
) => {
  const trace = createScenarioTrace({ name, seed });
  const context = {
    name,
    seed,
    trace,
    tick: async (count = 1) => {
      for (let index = 0; index < count; index += 1) {
        trace.advance();
        await tickN(1);
      }
    },
  };

  try {
    const setupResult =
      typeof setup === "function" ? await setup(context) : undefined;
    if (setupResult && typeof setupResult === "object") {
      Object.assign(context, setupResult);
    }

    if (typeof run === "function") {
      await run(context);
    }
    if (typeof assert === "function") {
      await assert(context);
    }
    return context;
  } catch (error) {
    const traceText = trace.formatFailure({
      invariant: error?.invariant,
      cause: error?.message,
      traceTail,
    });
    if (error && typeof error.message === "string") {
      error.message = `${error.message}\n\n${traceText}`;
    }
    throw error;
  } finally {
    if (typeof cleanup === "function") {
      await cleanup(context);
    }
  }
};

