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

## Implementation Plan

### 1. Modify RepositoryStore interface (src/repository.js)

Add partition parameter to existing getEvents function:

```javascript
/**
 * @typedef {Object} RepositoryStore
 * @property {(partitionId?: string) => Promise<RepositoryEvent[]|undefined>} getEvents
 * @property {(event: RepositoryEvent) => Promise<void>} appendEvent
 */
```

### 2. Modify addEvent function (src/repository.js)

Add partition support to the existing addEvent function:

```javascript
const addEvent = async (event, partitionId) => {
  // Validate init events are not allowed through addEvent
  if (event.type === "init") {
    throw new Error(
      "Init events can only be created through repository.init()",
    );
  }

  // Transform new event format to internal format
  const internalEvent = {
    type: event.type,
    payload: {
      ...event.payload,
      ...(partitionId && { partitionId })
    }
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

### 3. Modify getEvents function (src/repository.js)

Add partition support to existing getEvents function:

```javascript
const getEvents = (partitionId) => {
  if (partitionId) {
    return cachedEvents.filter(event => event.payload.partitionId === partitionId);
  }
  return cachedEvents;
};
```

### 4. Modify init function (src/repository.js)

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

return {
  init,
  addEvent,
  getState,
  getEvents,
};
```

## Usage Example

```javascript
// Add event to specific partition
await repository.addEvent(event, 'user_123');

// Get all events
const allEvents = repository.getEvents();

// Get events from specific partition
const userEvents = repository.getEvents('user_123');

// Compute partition state (application layer responsibility)
const computePartitionState = (partitionId) => {
  const partitionEvents = repository.getEvents(partitionId);
  let state = {};
  for (const event of partitionEvents) {
    state = applyEventToState(state, event);
  }
  return state;
};

const userState = computePartitionState('user_123');
```