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

### 1. Modify RepositoryEvent interface (src/repository.js)

Add partition field to RepositoryEvent type definition:

```javascript
/**
 * @typedef {Object} RepositoryEvent
 * @property {RepositoryEventType} type
 * @property {RepositoryEventPayload} payload
 * @property {string} [partitionId] - Optional partition identifier
 */
```

### 2. Modify RepositoryStore interface (src/repository.js)

Add partition support methods to RepositoryStore:

```javascript
/**
 * @typedef {Object} RepositoryStore
 * @property {() => Promise<RepositoryEvent[]|undefined>} getEvents
 * @property {(event: RepositoryEvent) => Promise<void>} appendEvent
 * @property {(partitionId: string) => Promise<RepositoryEvent[]>} getEventsByPartition
 * @property {(partitionId: string, state: RepositoryState) => Promise<void>} savePartitionState
 */
```

### 3. Modify addEvent function (src/repository.js)

Add partition support to the existing addEvent function:

```javascript
const addEvent = async (event, options = {}) => {
  const { partitionId } = options;

  // Validate init events are not allowed through addEvent
  if (event.type === "init") {
    throw new Error(
      "Init events can only be created through repository.init()",
    );
  }

  // Transform new event format to internal format
  const internalEvent = {
    type: event.type,
    payload: event.payload,
    ...(partitionId && { partitionId })
  };

  cachedEvents.push(internalEvent);
  latestState = applyEventToState(latestState, internalEvent);
  latestComputedIndex += 1;

  if (latestComputedIndex % CHECKPOINT_INTERVAL === 0) {
    storeCheckpoint(latestComputedIndex, latestState);
  }

  // Generate materialized view for partition if partitionId provided
  if (partitionId) {
    await generateMaterializedView(partitionId);
  }

  await store.appendEvent(internalEvent);
};
```

### 4. Add generateMaterializedView function (src/repository.js)

Implement materialized view generation:

```javascript
const generateMaterializedView = async (partitionId) => {
  // Fetch all events in the partition
  const partitionEvents = await store.getEventsByPartition(partitionId);

  // Compute final state from partition events
  let finalState = {};
  for (const event of partitionEvents) {
    finalState = applyEventToState(finalState, event);
  }

  // Save final state into the materialized view
  await store.savePartitionState(partitionId, finalState);
};
```

### 5. Add getPartitionState function (src/repository.js)

Add function to get partition materialized view state:

```javascript
const getPartitionState = async (partitionId) => {
  const partitionEvents = await store.getEventsByPartition(partitionId);

  let finalState = {};
  for (const event of partitionEvents) {
    finalState = applyEventToState(finalState, event);
  }

  return finalState;
};

return {
  init,
  addEvent,
  getState,
  getEvents,
  getPartitionState, // New function
};
```