---
title: feat partition
status: todo
priority: low
---

# Description

local checkpoints is kind of already supported. but does not solve the memory limit issue.
to solve memory limit for a big state:
- add partition column for every event.  add patition to  toAddEvent(), and store that in a db column.,
- generate a materialized view after every event. similar to how we do now.
   - for generating the materialized view:
      - fetch all events in the partition,
      - compute all events in the partitin to get get final state,
      - save final state into the materialized view,
      - all this can be done without getting all the events or having the full state.

## Target Implementation

The README shows the target functionality we need to implement:

### Target API Usage:
```javascript
// Target repository creation
const repositoryWithPartition = createRepository({
  originStore: store,
  usingCachedEvents: false  // should be false for partition support
});

// Target event addition
await repository.addEvent({
  type: "treePush",
  partition: "session-1",  // partition field at event level
  payload: {
    target: "explorer",
    value: { id: "1", name: "New Folder", type: "folder" },
    options: { parent: "_root" }
  }
});

// Target state retrieval
const stateWithPartition = await repository.getState({ partition: "session-1" })
```

### Target Store Interface:
```javascript
const store = {
  async getEvents(payload) {
    // should handle {} for all events or { partition: ... } for partition events
    console.log(payload);
    return [];
  },
  async appendEvent(event) {
    // should receive { type: ..., partition: ..., payload: {...} }
    console.log("saved", event);
  },
};
```

## Implementation Plan

### 1. Modify RepositoryEvent interface (src/repository.js)

Add partition field to RepositoryEvent type definition:

```javascript
/**
 * @typedef {Object} RepositoryEvent
 * @property {RepositoryEventType} type
 * @property {RepositoryEventPayload} payload
 * @property {string} [partition] - Optional partition identifier
 */
```

### 2. Modify RepositoryStore interface (src/repository.js)

Update RepositoryStore to support partition filtering:

```javascript
/**
 * @typedef {Object} RepositoryStore
 * @property {(payload?: object) => Promise<RepositoryEvent[]|undefined>} getEvents
 * @property {(event: RepositoryEvent) => Promise<void>} appendEvent
 */
```

### 3. Modify addEvent function (src/repository.js)

Update addEvent to handle event-level partition field:

```javascript
const addEvent = async (event) => {
  // Validate init events are not allowed through addEvent
  if (event.type === "init") {
    throw new Error(
      "Init events can only be created through repository.init()",
    );
  }

  // Event now includes partition field directly
  const internalEvent = {
    type: event.type,
    payload: event.payload,
    ...(event.partition && { partition: event.partition })
  };

  cachedEvents.push(internalEvent);
  latestState = applyEventToState(latestState, internalEvent);
  latestComputedIndex += 1;

  if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
    storeCheckpoint(latestComputedIndex, latestState);
  }

  await store.appendEvent(internalEvent);
};
```

### 4. Modify getEvents function (src/repository.js)

Add partition filtering support:

```javascript
const getEvents = () => {
  return cachedEvents;
};
```

### 5. Modify getState function (src/repository.js)

Add partition support for state computation:

```javascript
const getState = (options = {}) => {
  const { partition } = options;

  const targetIndex = options.untilActionIndex !== undefined
    ? Math.max(0, Math.min(options.untilActionIndex, cachedEvents.length))
    : cachedEvents.length;

  if (partition) {
    // Filter events by partition for memory efficiency
    const partitionEvents = cachedEvents.filter(event => event.partition === partition);

    // Compute state only from partition events
    let partitionState = {};
    for (const event of partitionEvents) {
      partitionState = applyEventToState(partitionState, event);
    }

    return partitionState;
  }

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
```

### 6. Modify init function (src/repository.js)

Update init to support partition-aware event loading:

```javascript
const init = async ({ initialState: providedInitialState } = {}) => {
  resetCheckpoints();
  cachedEvents = (await store.getEvents()) || [];

  cachedEvents.forEach((event, index) => {
    latestState = applyEventToState(latestState, event);
    latestComputedIndex = index + 1;

    if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
      storeCheckpoint(latestComputedIndex, latestState);
    }
  });

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

    cachedEvents.push(initEvent);
    latestState = applyEventToState(latestState, initEvent);
    latestComputedIndex += 1;

    storeCheckpoint(latestComputedIndex, latestState);
    await store.appendEvent(initEvent);
  }
};
```

### 7. Update createRepository function (src/repository.js)

Add usingCachedEvents parameter to support partition mode:

```javascript
export const createRepository = ({ originStore, usingCachedEvents = true }) => {
  const store = originStore;
  const CHECKPOINT_INTERVAL = 50;

  let cachedEvents = [];

  // Only use cached events if usingCachedEvents is true
  // For partition support, this should be false
  if (usingCachedEvents) {
    // Load events from store
    // ... existing cache loading logic
  }

  return {
    init,
    addEvent,
    getState,
    getEvents,
  };
};
```

## Implementation Order

1. **RepositoryEvent interface** - Add partition field
2. **addEvent function** - Support partition field in events
3. **getState function** - Support partition parameter
4. **RepositoryStore interface** - Support partition filtering
5. **init function** - Handle partition-aware event loading
6. **createRepository** - Add usingCachedEvents parameter