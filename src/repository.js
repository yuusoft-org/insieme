import {
  set,
  unset,
  treePush,
  treeDelete,
  treeUpdate,
  treeMove,
  init as initAction,
} from "./actions.js";

/**
 * @typedef {import("./actions.js").SetPayload} SetPayload
 * @typedef {import("./actions.js").UnsetPayload} UnsetPayload
 * @typedef {import("./actions.js").TreePushPayload} TreePushPayload
 * @typedef {import("./actions.js").TreeDeletePayload} TreeDeletePayload
 * @typedef {import("./actions.js").TreeUpdatePayload} TreeUpdatePayload
 * @typedef {import("./actions.js").TreeMovePayload} TreeMovePayload
 * @typedef {import("./actions.js").InitPayload} InitPayload
 */

/**
 * @typedef {SetPayload | UnsetPayload | TreePushPayload | TreeDeletePayload | TreeUpdatePayload | TreeMovePayload | InitPayload} RepositoryEventPayload
 */

/**
 * @typedef {"set"|"unset"|"treePush"|"treeDelete"|"treeUpdate"|"treeMove"|"init"} RepositoryEventType
 */

/**
 * @typedef {Object} RepositoryEvent
 * @property {RepositoryEventType} type
 * @property {RepositoryEventPayload} payload
 * @property {string} [partition] - Optional partition identifier
 */

/**
 * @typedef {Record<string, unknown>} RepositoryState
 */

/**
 * @typedef {Object} RepositoryStore
 * @property {(payload?: object) => Promise<RepositoryEvent[]|undefined>} getEvents
 * @property {(event: RepositoryEvent) => Promise<void>} appendEvent
 */

/**
 * Creates an internal repository instance with event sourcing and checkpointing.
 * Manages state through an append-only log with periodic checkpoints for performance.
 *
 * @param {{ originStore: RepositoryStore, usingCachedEvents?: boolean }} options - Repository options
 * @param {RepositoryStore} options.originStore - The store for persisting events
 * @param {boolean} [options.usingCachedEvents=true] - Whether to use cached events in memory
 * @returns {{ init: (options?: { initialState?: RepositoryState }) => Promise<void>, addEvent: (event: RepositoryEvent) => Promise<void>, getState: (untilEventIndex?: number) => RepositoryState, getEvents: () => RepositoryEvent[], getEventsAsync: (payload?: object) => Promise<RepositoryEvent[]>, getStateAsync: (options?: {partition?: string, untilEventIndex?: number}) => Promise<RepositoryState> }} Repository API
 *
 * @private This is an internal function used by factory functions
 */
export const createRepository = ({ originStore, usingCachedEvents = true }) => {
  /** @type {RepositoryStore} */
  const store = originStore;
  const CHECKPOINT_INTERVAL = 50;

  /** @type {RepositoryEvent[]} */
  let cachedEvents = [];
  /** @type {Map<number, RepositoryState>} */
  const checkpoints = new Map();
  /** @type {number[]} */
  const checkpointIndexes = [];

  let latestComputedIndex = 0;
  /** @type {RepositoryState} */
  let initialState = {};
  /** @type {RepositoryState} */
  let latestState = structuredClone(initialState);

  /**
   * Stores a checkpoint at the specified action index.
   * Used for performance optimization to avoid replaying all events.
   *
   * @param {number} index - The action index to checkpoint
   * @param {Object} state - The state to checkpoint
   */
  /**
   * @param {number} index
   * @param {RepositoryState} state
   * @returns {void}
   */
  const storeCheckpoint = (index, state) => {
    if (!checkpoints.has(index)) {
      checkpointIndexes.push(index);
    }
    checkpoints.set(index, state);
  };

  /**
   * Resets all checkpoints and recomputed state.
   * Used during initialization to start from a clean state.
   */
  /** @returns {void} */
  const resetCheckpoints = () => {
    checkpoints.clear();
    checkpointIndexes.length = 0;
    latestComputedIndex = 0;
    latestState = structuredClone(initialState);
    storeCheckpoint(0, latestState);
  };

  /**
   * Applies an action to the current state and returns the new state.
   * Central dispatcher for all supported action types.
   *
   * @param {Object} state - The current state
   * @param {Object} action - The action to apply
   * @param {string} action.actionType - Type of action (set, unset, treePush, etc.)
   * @param {Object} action.payload - Action payload containing all action-specific data
   * @returns {Object} New state after applying the action
   */
  /**
   * @param {RepositoryState} state
   * @param {RepositoryEvent} event
   * @returns {RepositoryState}
   */
  const applyEventToState = (state, event) => {
    const { type, payload } = event;
    if (type === "set") {
      return set(state, payload);
    } else if (type === "unset") {
      return unset(state, payload);
    } else if (type === "treePush") {
      return treePush(state, payload);
    } else if (type === "treeDelete") {
      return treeDelete(state, payload);
    } else if (type === "treeUpdate") {
      return treeUpdate(state, payload);
    } else if (type === "treeMove") {
      return treeMove(state, payload);
    } else if (type === "init") {
      return initAction(state, payload);
    }
    return state;
  };

  /**
   * Initializes the repository by loading all events from storage.
   * Replays events to reconstruct current state and creates checkpoints.
   *
   * @returns {Promise<void>}
   */
  /**
   * @param {{ initialState?: RepositoryState }} [options]
   * @returns {Promise<void>}
   */
  const init = async ({ initialState: providedInitialState } = {}) => {
    resetCheckpoints();

    if (usingCachedEvents) {
      cachedEvents = (await store.getEvents()) || [];

      // Process cached events to rebuild state
      cachedEvents.forEach((event, index) => {
        latestState = applyEventToState(latestState, event);
        latestComputedIndex = index + 1;

        if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
          // Store reference to current latestState as checkpoint
          storeCheckpoint(latestComputedIndex, latestState);
        }
      });
    } else {
      // For partition mode, don't cache events in memory
      cachedEvents = null;
    }

    if (latestComputedIndex !== 0 && !checkpoints.has(latestComputedIndex)) {
      storeCheckpoint(latestComputedIndex, latestState);
    }

    // If there are no events and initial state is provided, create an init event
    if (cachedEvents.length === 0 && providedInitialState) {
      const initEvent = {
        type: "init",
        payload: {
          value: providedInitialState,
        },
      };

      // Directly handle init event creation without going through addEvent
      cachedEvents.push(initEvent);
      latestState = applyEventToState(latestState, initEvent);
      latestComputedIndex += 1;

      storeCheckpoint(latestComputedIndex, latestState);
      await store.appendEvent(initEvent);
    }
  };

  /**
   * Adds a new action to the event log and updates the current state.
   * Persists the action to storage and creates checkpoints periodically.
   *
   * @param {Object} action - The action to add to the event log
   * @returns {Promise<void>}
   */
  /**
   * @param {RepositoryEvent} event
   * @returns {Promise<void>}
   */
  const addEvent = async (event) => {
    // Validate that init events are not allowed through addEvent
    if (event.type === "init") {
      throw new Error(
        "Init events can only be created through repository.init()",
      );
    }

    // Event now includes partition field directly
    const internalEvent = {
      type: event.type,
      payload: event.payload,
      ...(event.partition && { partition: event.partition }),
    };

    if (usingCachedEvents) {
      cachedEvents.push(internalEvent);
      latestState = applyEventToState(latestState, internalEvent);
      latestComputedIndex += 1;

      if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
        storeCheckpoint(latestComputedIndex, latestState);
      }
    }

    await store.appendEvent(internalEvent);
  };

  /**
   * Finds the best checkpoint index to use for reconstructing state.
   * Returns the most recent checkpoint that is at or before the target index.
   *
   * @param {number} targetIndex - The target action index
   * @returns {number} The checkpoint index to start from
   */
  /**
   * @param {number} targetIndex
   * @returns {number}
   */
  const findCheckpointIndex = (targetIndex) => {
    for (let i = checkpointIndexes.length - 1; i >= 0; i--) {
      if (checkpointIndexes[i] <= targetIndex) {
        return checkpointIndexes[i];
      }
    }
    return 0;
  };

  /**
   * Gets the state at a specific point in time, or the current state.
   * Uses checkpoints for efficient state reconstruction.
   * Only available when usingCachedEvents=true.
   *
   * @param {number} [untilEventIndex] - Optional index to get state up to (exclusive)
   * @returns {RepositoryState} The state at the specified point in time
   *
   * @example
   * const currentState = getState();
   * const historicalState = getState(10); // State after first 10 actions
   */
  /**
   * @param {number} [untilEventIndex] - Optional index to get state up to (exclusive)
   * @returns {RepositoryState}
   */
  const getState = (untilEventIndex) => {
    if (!usingCachedEvents) {
      throw new Error(
        "getState is only available when usingCachedEvents=true. " +
          "Use getStateAsync() instead.",
      );
    }

    const targetIndex =
      untilEventIndex !== undefined
        ? Math.max(0, Math.min(untilEventIndex, cachedEvents.length))
        : cachedEvents.length;

    if (targetIndex === latestComputedIndex) {
      return structuredClone(latestState);
    }

    const checkpointIndex = findCheckpointIndex(targetIndex);
    let state = structuredClone(checkpoints.get(checkpointIndex));

    for (let i = checkpointIndex; i < targetIndex; i++) {
      state = applyEventToState(state, cachedEvents[i]);
    }

    return state;
  };

  /**
   * Gets all events from the cached action stream.
   * Returns the complete event log for the repository.
   *
   * @returns {Array<Object>} Array of all actions in chronological order
   */
  /** @returns {RepositoryEvent[]} */
  const getEvents = () => {
    return cachedEvents;
  };

  const getEventsAsync = async (payload) => {
    return await store.getEvents(payload);
  };

  /**
   * Gets the state asynchronously, designed for non-cached mode.
   * This is memory-efficient for large datasets as it doesn't require caching all events.
   *
   * @param {{partition?: string, untilEventIndex?: number}} [options] - State options
   * @param {string} [options.partition] - Partition identifier for partition-specific state
   * @param {number} [options.untilEventIndex] - Get state up to specific action index (exclusive)
   * @returns {Promise<RepositoryState>} The computed state
   * @throws {Error} If usingCachedEvents=true - use getState() instead
   */
  const getStateAsync = async (options = {}) => {
    if (usingCachedEvents) {
      throw new Error(
        "getStateAsync is only available when usingCachedEvents=false. Use getState() instead.",
      );
    }

    const { partition, untilEventIndex } = options;

    let events;
    if (partition) {
      // Get partition events
      events = await getEventsAsync({ partition });
    } else {
      // Get all events
      events = await getEventsAsync();
    }

    // Apply untilEventIndex filter if specified
    const targetIndex =
      untilEventIndex !== undefined
        ? Math.max(0, Math.min(untilEventIndex, events.length))
        : events.length;

    const limitedEvents = events.slice(0, targetIndex);

    // Compute state from events
    let state = {};
    for (const event of limitedEvents) {
      state = applyEventToState(state, event);
    }

    return state;
  };

  return {
    init,
    addEvent,
    getState,
    getEvents,
    getEventsAsync,
    getStateAsync,
  };
};
