import { set, unset, treePush, treeDelete, treeUpdate, treeMove } from "./actions.js";

/**
 * Creates an internal repository instance with event sourcing and checkpointing.
 * Manages state through an append-only log with periodic checkpoints for performance.
 *
 * @param {Object} options - Repository options
 * @param {Object} options.originStore - Storage adapter for persisting events
 * @returns {Object} Repository instance with state management methods
 *
 * @private This is an internal function used by factory functions
 */
export const createRepository = ({ originStore }) => {
  const store = originStore;
  const CHECKPOINT_INTERVAL = 50;

  let cachedEvents = [];
  const checkpoints = new Map();
  const checkpointIndexes = [];

  let latestComputedIndex = 0;
  let initialState = {};
  let latestState = structuredClone(initialState);

  /**
   * Stores a checkpoint at the specified action index.
   * Used for performance optimization to avoid replaying all events.
   *
   * @param {number} index - The action index to checkpoint
   * @param {Object} state - The state to checkpoint
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
  const applyEventToState = (state, event) => {
    const { actionType, payload } = event;
    if (actionType === "set") {
      return set(state, payload);
    } else if (actionType === "unset") {
      return unset(state, payload);
    } else if (actionType === "treePush") {
      return treePush(state, payload);
    } else if (actionType === "treeDelete") {
      return treeDelete(state, payload);
    } else if (actionType === "treeUpdate") {
      return treeUpdate(state, payload);
    } else if (actionType === "treeMove") {
      return treeMove(state, payload);
    } else if (actionType === "init") {
      const newState = structuredClone(state);
      for (const [key, data] of Object.entries(payload)) {
        if (newState[key] !== undefined) {
          newState[key] = data;
        }
      }
      return newState;
    }
    return state;
  };

  /**
   * Initializes the repository by loading all events from storage.
   * Replays events to reconstruct current state and creates checkpoints.
   *
   * @returns {Promise<void>}
   */
  const init = async ({ initialState: providedInitialState } = {}) => {
    if (providedInitialState) {
      initialState = providedInitialState;
      latestState = structuredClone(initialState);
    }
    resetCheckpoints();
    cachedEvents = (await store.getEvents()) || [];

    cachedEvents.forEach((event, index) => {
      latestState = applyEventToState(latestState, event);
      latestComputedIndex = index + 1;

      if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
        // Store reference to current latestState as checkpoint
        storeCheckpoint(latestComputedIndex, latestState);
      }
    });

    if (latestComputedIndex !== 0 && !checkpoints.has(latestComputedIndex)) {
      storeCheckpoint(latestComputedIndex, latestState);
    }
  };

  /**
   * Adds a new action to the event log and updates the current state.
   * Persists the action to storage and creates checkpoints periodically.
   *
   * @param {Object} action - The action to add to the event log
   * @returns {Promise<void>}
   */
  const addEvent = async (event) => {
    // Transform new event format to internal format
    const internalEvent = {
      actionType: event.type,
      payload: event.payload
    };

    cachedEvents.push(internalEvent);
    latestState = applyEventToState(latestState, internalEvent);
    latestComputedIndex += 1;

    if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
      storeCheckpoint(latestComputedIndex, latestState);
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
   *
   * @param {number} [untilActionIndex] - Optional index to get state up to (exclusive)
   * @returns {Object} The state at the specified point in time
   *
   * @example
   * const currentState = getState();
   * const historicalState = getState(10); // State after first 10 actions
   */
  const getState = (untilEventIndex) => {
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
  const getEvents = () => {
    return cachedEvents;
  };

  return {
    init,
    addEvent,
    getState,
    getEvents,
  };
};

