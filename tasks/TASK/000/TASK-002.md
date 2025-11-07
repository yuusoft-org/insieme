---
title: repository setup
status: done
priority: low
---

# Description

Currently there is inconsistency between the README.md quickstart API and the actual insieme.js API

In the quickstart, we have to pass storage to a draftStore and sourceStore, while in the implmeentaiton we have a init function.

We have to do the following

This will be the truth API that we need to implement and update README with:

```js
import { createRepository } from "insieme";

const store = {
  async getEvents() { return []; },
  async appendEvent(event) { console.log("saved", event); },
};

const repository = createRepository({
  originStore: store
})

await repository.init({
  initialState
});

// apply an event
await repository.addEvent({
  type: "treePush",
  payload: {
    target: "explorer",
    value: { id: "1", name: "New Folder", type: "folder" },
    options: { parent: "_root" }
  }
});

// read the current state
console.log(repository.getState());
```

# Implementation Plan

## Analysis of Current Issues

1. **Repository creation signature mismatch**:
   - Current: `createRepository(initialState, store)`
   - Target: `createRepository({ originStore })`

2. **Initialization method mismatch**:
   - Current: `init()` with no parameters
   - Target: `init({ initialState })`

3. **Event terminology mismatch**:
   - Current: `addAction`, `getAllEvents`, `store.addAction()`, `store.getAllEvents()`
   - Target: `addEvent`, `getEvents`, `store.appendEvent()`, `store.getEvents()`

4. **Unnecessary app interface**:
   - Current: Repository exposes `app` interface for key-value storage
   - Target: Repository focused only on event sourcing

## Implementation Steps

### 1. Update createRepository function signature
- Change `createRepository(initialState, store)` to `createRepository({ originStore })`
- Move `initialState` parameter to the `init()` method
- Store `originStore` as the internal `store` variable

### 2. Update init method
- Accept optional `{ initialState }` parameter
- If provided, use it as the initial state instead of requiring it at creation time
- Set default empty state if none provided

### 3. Update event terminology
- Rename `addAction` → `addEvent`
- Rename `getAllEvents` → `getEvents`
- Update store interface: `store.addAction()` → `store.appendEvent()`, `store.getAllEvents()` → `store.getEvents()`
- Update internal variable names: `cachedActionStreams` → `cachedEvents`, `applyActionToState` → `applyEventToState`

### 4. Remove app interface
- Remove `app` property from repository return object
- Focus repository purely on event sourcing functionality
- Update documentation to remove app storage examples

### 5. Update factory exports in index.js
- Ensure the new `createRepository` is exported correctly
- Update any related factory functions that might be affected

### 6. Update README.md
- Replace all examples with the correct API
- Remove references to `draftStore`, `sourceStore`, `remoteAdapter`, and `app` interface
- Update Quick Start and API Documentation sections to use event terminology

## Code Changes Required

### File: src/repository.js
```js
// Before:
export const createRepository = (initialState, store) => {

// After:
export const createRepository = ({ originStore }) => {
  const store = originStore;
  let initialState = {};
```

```js
// Before:
const init = async () => {
  cachedActionStreams = (await store.getAllEvents()) || [];
  resetCheckpoints();

// After:
const init = async ({ initialState: providedInitialState } = {}) => {
  if (providedInitialState) {
    initialState = providedInitialState;
  }
  resetCheckpoints(); // This needs to be called after setting initialState
  cachedEvents = (await store.getEvents()) || [];
```

```js
// Before:
const addAction = async (action) => {
  cachedActionStreams.push(action);
  latestState = applyActionToState(latestState, action);

// After:
const addEvent = async (event) => {
  // Transform new event format to internal format
  const internalEvent = {
    actionType: event.type,
    payload: event.payload
  };

  cachedEvents.push(internalEvent);
  latestState = applyEventToState(latestState, internalEvent);
```

### File: src/index.js
- Update export to reference the renamed repository.js file (already done)

### File: README.md
- Update Quick Start example to use new API
- Update API Documentation section to use event terminology
- Remove outdated store configuration examples
- Remove app interface references from all examples




