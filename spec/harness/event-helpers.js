let eventCounter = 0;
export const makeEvent = (overrides = {}) => ({
  partition: overrides.partition || "P1",
  type: overrides.type || "test_event",
  schemaVersion: overrides.schemaVersion || 1,
  payload: overrides.payload || { n: ++eventCounter },
});
export const makeBatch = (count, overrides = {}) =>
  Array.from({ length: count }, (_, i) => makeEvent({ ...overrides, payload: { n: i + 1 } }));
export const resetEventCounter = () => { eventCounter = 0; };
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const tickN = async (n) => { for (let i = 0; i < n; i++) await tick(); };
export const createRng = (seed) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
