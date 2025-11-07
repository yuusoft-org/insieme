import { createTauriSQLiteRepositoryAdapter } from "./tauriRepositoryAdapter.js";
import { set, unset, treePush, treeDelete, treeUpdate, treeMove } from "./actions.js";

/**
 * Creates a web repository factory for browser environments.
 * Manages a single repository instance that ignores project IDs.
 *
 * @param {Object} initialState - The initial state for the repository
 * @param {Object} store - Storage adapter for the web environment
 * @returns {Object} Factory object with getByProject method
 *
 * @example
 * const factory = createWebRepositoryFactory(initialState, webStore);
 * const repository = await factory.getByProject('any-project-id');
 */
export const createWebRepositoryFactory = (initialState, store) => {
  let repository = null;

  return {
    async getByProject(_projectId) {
      // Web version ignores projectId - always returns the same repository
      if (!repository) {
        repository = createRepository(initialState, store);
        await repository.init();
      }
      return repository;
    },
  };
};

/**
 * Creates a Tauri repository factory for desktop applications with multi-project support.
 * Manages multiple repository instances with SQLite storage for each project.
 *
 * @param {Object} initialState - The initial state for new repositories
 * @param {Object} keyValueStore - Key-value store for project metadata
 * @returns {Object} Factory object with getByProject and getByPath methods
 *
 * @example
 * const factory = createRepositoryFactory(initialState, keyValueStore);
 * const repo1 = await factory.getByProject('project-123');
 * const repo2 = await factory.getByPath('/path/to/project');
 */
export const createRepositoryFactory = (initialState, keyValueStore) => {
  const repositoriesByProject = new Map();
  const repositoriesByPath = new Map();

  /**
   * Gets or creates a repository for a specific project path.
   * Caches repositories by path to avoid duplicate instances.
   *
   * @param {string} projectPath - File system path to the project
   * @returns {Promise<Object>} Repository instance
   */
  const getOrCreateRepositoryByPath = async (projectPath) => {
    if (repositoriesByPath.has(projectPath)) {
      return repositoriesByPath.get(projectPath);
    }

    const store = await createTauriSQLiteRepositoryAdapter(projectPath);
    const repository = createRepository(initialState, store);
    await repository.init();
    repositoriesByPath.set(projectPath, repository);
    return repository;
  };

  const repositoryFactory = {
    /**
     * Gets a repository by project ID.
     * Looks up project path in the key-value store and creates/returns repository.
     *
     * @param {string} projectId - Unique identifier for the project
     * @returns {Promise<Object>} Repository instance for the project
     * @throws {Error} If project is not found in the key-value store
     */
    getByProject: async (projectId) => {
      if (repositoriesByProject.has(projectId)) {
        return repositoriesByProject.get(projectId);
      }

      const projects = (await keyValueStore.get("projects")) || [];
      const project = projects.find((project) => project.id === projectId);
      if (!project) {
        throw new Error("project not found");
      }

      const repository = await getOrCreateRepositoryByPath(project.projectPath);
      repositoriesByProject.set(projectId, repository);
      return repository;
    },
    /**
     * Gets a repository by file system path.
     * Creates or returns cached repository for the specified path.
     *
     * @param {string} projectPath - File system path to the project
     * @returns {Promise<Object>} Repository instance
     */
    getByPath: async (projectPath) => {
      return await getOrCreateRepositoryByPath(projectPath);
    },
  };

  return repositoryFactory;
};

/**
 * Creates an internal repository instance with event sourcing and checkpointing.
 * Manages state through an append-only log with periodic checkpoints for performance.
 *
 * @param {Object} initialState - The initial state for the repository
 * @param {Object} store - Storage adapter for persisting events
 * @returns {Object} Repository instance with state management methods
 *
 * @private This is an internal function used by factory functions
 */
const createRepository = (initialState, store) => {
  const CHECKPOINT_INTERVAL = 50;

  let cachedActionStreams = [];
  const checkpoints = new Map();
  const checkpointIndexes = [];

  let latestComputedIndex = 0;
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
  const applyActionToState = (state, action) => {
    const { actionType, payload } = action;
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
  const init = async () => {
    cachedActionStreams = (await store.getAllEvents()) || [];
    resetCheckpoints();

    cachedActionStreams.forEach((action, index) => {
      latestState = applyActionToState(latestState, action);
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
  const addAction = async (action) => {
    cachedActionStreams.push(action);
    latestState = applyActionToState(latestState, action);
    latestComputedIndex += 1;

    if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
      storeCheckpoint(latestComputedIndex, latestState);
    }

    await store.addAction(action);
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
  const getState = (untilActionIndex) => {
    const targetIndex =
      untilActionIndex !== undefined
        ? Math.max(0, Math.min(untilActionIndex, cachedActionStreams.length))
        : cachedActionStreams.length;

    if (targetIndex === latestComputedIndex) {
      return structuredClone(latestState);
    }

    const checkpointIndex = findCheckpointIndex(targetIndex);
    let state = structuredClone(checkpoints.get(checkpointIndex));

    for (let i = checkpointIndex; i < targetIndex; i++) {
      state = applyActionToState(state, cachedActionStreams[i]);
    }

    return state;
  };

  /**
   * Gets all events from the cached action stream.
   * Returns the complete event log for the repository.
   *
   * @returns {Array<Object>} Array of all actions in chronological order
   */
  const getAllEvents = () => {
    return cachedActionStreams;
  };

  return {
    init,
    addAction,
    getState,
    getAllEvents,
    app: {
      get: store.app.get,
      set: store.app.set,
      remove: store.app.remove,
    },
  };
};

