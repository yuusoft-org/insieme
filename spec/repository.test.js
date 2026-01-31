/**
 * Unit tests for repository module
 * Tests event sourcing, checkpointing, and state management functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRepository } from './src/repository.js';

// Mock store implementation for testing
const createMockStore = () => {
  let events = [];
  return {
    getEvents: vi.fn().mockImplementation(() => Promise.resolve([...events])), // Return a fresh copy each time
    appendEvent: vi.fn().mockImplementation((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    clearEvents: vi.fn().mockImplementation(() => {
      events = [];
    }),
    _getEvents: () => events, // Helper for test inspection
  };
};

// Mock store with snapshot support for testing
const createMockStoreWithSnapshots = () => {
  let events = [];
  let snapshot = null;
  return {
    getEvents: vi.fn().mockImplementation((payload) => {
      // Support 'since' parameter for optimized loading
      if (payload && payload.since !== undefined) {
        return Promise.resolve(events.slice(payload.since));
      }
      // Support 'partition' parameter (for completeness)
      if (payload && payload.partition) {
        return Promise.resolve(events.filter(e => e.partition === payload.partition));
      }
      return Promise.resolve([...events]);
    }),
    appendEvent: vi.fn().mockImplementation((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    getSnapshot: vi.fn().mockImplementation(() => Promise.resolve(snapshot)),
    setSnapshot: vi.fn().mockImplementation((s) => {
      snapshot = s;
      return Promise.resolve();
    }),
    clearEvents: vi.fn().mockImplementation(() => {
      events = [];
    }),
    clearSnapshot: vi.fn().mockImplementation(() => {
      snapshot = null;
    }),
    _getEvents: () => events,
    _getSnapshot: () => snapshot,
    _setEvents: (e) => { events = e; },
    _setSnapshot: (s) => { snapshot = s; },
  };
};

describe('createRepository', () => {
  let mockStore;
  let repository;

  beforeEach(() => {
    mockStore = createMockStore();
    repository = createRepository({ originStore: mockStore });
  });

  describe('basic functionality', () => {
    it('should create a repository with required methods', () => {
      expect(repository).toHaveProperty('init');
      expect(repository).toHaveProperty('addEvent');
      expect(repository).toHaveProperty('getState');
      expect(repository).toHaveProperty('getEvents');
      expect(typeof repository.init).toBe('function');
      expect(typeof repository.addEvent).toBe('function');
      expect(typeof repository.getState).toBe('function');
      expect(typeof repository.getEvents).toBe('function');
    });

    it('should initialize with empty state when no events exist', async () => {
      await repository.init();
      const state = repository.getState();
      expect(state).toEqual({});
    });

    it('should initialize with provided initial state and getState should return correct value', async () => {
      const initialState = {
        explorer: {
          items: {
            folder1: { id: 'folder1', name: 'Documents', type: 'folder' },
            file1: { id: 'file1', name: 'readme.txt', type: 'file' }
          },
          tree: [
            { id: 'folder1', children: [] },
            { id: 'file1', children: [] }
          ]
        },
        settings: {
          theme: 'dark',
          language: 'en'
        }
      };

      await repository.init({ initialState });

      const state = repository.getState();
      expect(state).toEqual(initialState);

      // Verify that an init event was created and stored
      const events = repository.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'init',
        payload: { value: initialState }
      });
    });

    it('should replay existing events during initialization', async () => {
      const events = [
        { type: 'set', payload: { target: 'counter', value: 1 } },
        { type: 'set', payload: { target: 'counter', value: 2 } },
        { type: 'set', payload: { target: 'name', value: 'test' } }
      ];
      mockStore.getEvents.mockResolvedValue(events);

      await repository.init();

      const state = repository.getState();
      expect(state).toEqual({ counter: 2, name: 'test' });
    });

    it('should not create init event when events already exist, even with initial state provided', async () => {
      const existingEvents = [
        { type: 'set', payload: { target: 'existing', value: 'data' } }
      ];
      mockStore.getEvents.mockResolvedValue(existingEvents);

      const initialState = {
        new: { state: 'should not be used' }
      };

      await repository.init({ initialState });

      const state = repository.getState();
      // Should replay existing events, not use provided initial state
      expect(state).toEqual({ existing: 'data' });

      // Should not have created a new init event
      const events = repository.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(existingEvents[0]);
    });

    it('should throw error when trying to add init event through addEvent (even when no events exist)', async () => {
      await repository.init();

      // Try to add an init event through addEvent - should throw
      await expect(repository.addEvent({
        type: 'init',
        payload: { value: { new: 'state' } }
      })).rejects.toThrow('Init events can only be created through repository.init()');
    });

    it('should throw error when trying to add init event through addEvent after other events exist', async () => {
      await repository.init();

      // Add a regular event first
      await repository.addEvent({
        type: 'set',
        payload: { target: 'counter', value: 1 }
      });

      // Try to add an init event through addEvent - should throw
      await expect(repository.addEvent({
        type: 'init',
        payload: { value: { new: 'state' } }
      })).rejects.toThrow('Init events can only be created through repository.init()');
    });

    it('should throw error when trying to add init event through addEvent to repository with existing events', async () => {
      // Mock repository with existing events
      const existingEvents = [
        { type: 'set', payload: { target: 'existing', value: 'data' } }
      ];
      mockStore.getEvents.mockResolvedValue(existingEvents);

      await repository.init();

      // Try to add an init event through addEvent - should throw
      await expect(repository.addEvent({
        type: 'init',
        payload: { value: { new: 'state' } }
      })).rejects.toThrow('Init events can only be created through repository.init()');
    });

    it('should load events from store during initialization', async () => {
      await repository.init();
      expect(mockStore.getEvents).toHaveBeenCalled();
    });
  });

  describe('mode validation', () => {
    it('should throw when mode is unknown', () => {
      expect(() => createRepository({ originStore: mockStore, mode: 'unknown' }))
        .toThrow('Unknown mode');
    });

    it('should require model when using model mode', () => {
      expect(() => createRepository({ originStore: mockStore, mode: 'model' }))
        .toThrow('Model mode requires a "model" option.');
    });

    it('should require integer model.version when provided', () => {
      expect(() => createRepository({
        originStore: mockStore,
        mode: 'model',
        model: { version: 'v1', schemas: {}, reduce() {} }
      })).toThrow('model.version must be an integer');
    });
  });

  describe('state management', () => {
    beforeEach(async () => {
      await repository.init();
    });

    it('should return empty state initially', () => {
      const state = repository.getState();
      expect(state).toEqual({});
    });

    it('should add events and update state', async () => {
      await repository.addEvent({
        type: 'set',
        payload: { target: 'user.name', value: 'Alice' }
      });

      const state = repository.getState();
      expect(state).toEqual({ user: { name: 'Alice' } });
    });

    it('should handle multiple events in sequence', async () => {
      await repository.addEvent({
        type: 'set',
        payload: { target: 'counter', value: 1 }
      });

      await repository.addEvent({
        type: 'set',
        payload: { target: 'counter', value: 2 }
      });

      await repository.addEvent({
        type: 'set',
        payload: { target: 'name', value: 'test' }
      });

      const state = repository.getState();
      expect(state).toEqual({ counter: 2, name: 'test' });
    });

    it('should return all cached events', async () => {
      await repository.addEvent({
        type: 'set',
        payload: { target: 'test', value: 'value' }
      });

      const events = repository.getEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]).toEqual({
        type: 'set',
        payload: { target: 'test', value: 'value' }
      });
    });

    it('should persist events to store', async () => {
      const event = {
        type: 'set',
        payload: { target: 'data.value', value: 42 }
      };

      await repository.addEvent(event);

      expect(mockStore.appendEvent).toHaveBeenCalledWith({
        type: 'set',
        payload: { target: 'data.value', value: 42 }
      });
    });
  });

  describe('event types support', () => {
    beforeEach(async () => {
      await repository.init();
    });

    it('should handle set events', async () => {
      await repository.addEvent({
        type: 'set',
        payload: { target: 'user.profile.name', value: 'John Doe' }
      });

      const state = repository.getState();
      expect(state).toEqual({
        user: { profile: { name: 'John Doe' } }
      });
    });

    it('should handle unset events', async () => {
      // First set a value
      await repository.addEvent({
        type: 'set',
        payload: { target: 'user.profile.name', value: 'John Doe' }
      });

      // Then unset it
      await repository.addEvent({
        type: 'unset',
        payload: { target: 'user.profile.name' }
      });

      const state = repository.getState();
      expect(state).toEqual({
        user: { profile: {} }
      });
    });

    it('should handle treePush events', async () => {
      // First initialize the target path with an empty object
      await repository.addEvent({
        type: 'set',
        payload: { target: 'fileExplorer', value: {} }
      });

      await repository.addEvent({
        type: 'treePush',
        payload: {
          target: 'fileExplorer',
          value: { id: 'folder1', name: 'My Folder', type: 'folder' }
        }
      });

      const state = repository.getState();
      expect(state.fileExplorer.items).toEqual({ folder1: { name: 'My Folder', type: 'folder' } });
      expect(state.fileExplorer.tree).toHaveLength(1);
      expect(state.fileExplorer.tree[0].id).toBe('folder1');
      expect(state.fileExplorer.tree[0].children).toEqual([]);
    });

    it('should handle treeUpdate events', async () => {
      // First initialize the target path
      await repository.addEvent({
        type: 'set',
        payload: { target: 'fileExplorer', value: {} }
      });

      // Then add a node
      await repository.addEvent({
        type: 'treePush',
        payload: {
          target: 'fileExplorer',
          value: { id: 'folder1', name: 'My Folder', type: 'folder' }
        }
      });

      // Then update it
      await repository.addEvent({
        type: 'treeUpdate',
        payload: {
          target: 'fileExplorer',
          value: { name: 'Updated Folder' },
          options: { id: 'folder1' }
        }
      });

      const state = repository.getState();
      expect(state.fileExplorer.items.folder1.name).toBe('Updated Folder');
    });

    it('should handle treeDelete events', async () => {
      // First initialize the target path
      await repository.addEvent({
        type: 'set',
        payload: { target: 'fileExplorer', value: {} }
      });

      // Then add a node
      await repository.addEvent({
        type: 'treePush',
        payload: {
          target: 'fileExplorer',
          value: { id: 'folder1', name: 'My Folder', type: 'folder' }
        }
      });

      // Then delete it
      await repository.addEvent({
        type: 'treeDelete',
        payload: {
          target: 'fileExplorer',
          options: { id: 'folder1' }
        }
      });

      const state = repository.getState();
      expect(state.fileExplorer.items).toEqual({});
      expect(state.fileExplorer.tree).toEqual([]);
    });
  });

  describe('state retrieval', () => {
    beforeEach(async () => {
      // Set up some events
      mockStore.getEvents.mockResolvedValue([
        { type: 'set', payload: { target: 'counter', value: 1 } },
        { type: 'set', payload: { target: 'counter', value: 2 } },
        { type: 'set', payload: { target: 'name', value: 'test' } },
        { type: 'set', payload: { target: 'counter', value: 3 } }
      ]);
      await repository.init();
    });

    it('should return current state when no index provided', () => {
      const state = repository.getState();
      expect(state).toEqual({ counter: 3, name: 'test' });
    });

    it('should return state at specific index', () => {
      const state = repository.getState({ untilEventIndex: 2 });
      expect(state).toEqual({ counter: 2 });
    });

    it('should return empty state for index 0', () => {
      const state = repository.getState({ untilEventIndex: 0 });
      expect(state).toEqual({});
    });

    it('should clamp index to valid range', () => {
      // Test index beyond range
      const state = repository.getState({ untilEventIndex: 100 });
      expect(state).toEqual({ counter: 3, name: 'test' });
    });

    it('should handle negative indices', () => {
      const state = repository.getState({ untilEventIndex: -1 });
      expect(state).toEqual({});
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await repository.init();
    });

    it('should reject unknown event types', async () => {
      await expect(repository.addEvent({
        type: 'unknownType',
        payload: { data: 'test' }
      })).rejects.toThrow('unknown event type');
    });

    it('should reject malformed event payloads', async () => {
      await expect(repository.addEvent({
        type: 'set',
        payload: { value: 'missing target' }
      })).rejects.toThrow('Event validation failed for type "set"');
    });
  });

  describe('immutability', () => {
    it('should use structuredClone for state immutability', async () => {
      await repository.init();

      await repository.addEvent({
        type: 'set',
        payload: { target: 'data', value: { nested: { value: 42 } } }
      });

      const state1 = repository.getState();
      const state2 = repository.getState();

      // States should be different objects (deep cloned)
      expect(state1).not.toBe(state2);
      // Verify that the structure exists and then check cloning
      expect(state1.data).toBeDefined();
      expect(state2.data).toBeDefined();
      // The values should be equal but not the same reference (when properly cloned)
      expect(state1.data.nested.value).toBe(state2.data.nested.value);
    });
  });

  describe('performance and checkpoint functionality', () => {
    it('should create checkpoints at regular intervals', async () => {
      await repository.init();

      // Add 51 events to trigger checkpoint creation (interval is 50)
      for (let i = 0; i < 51; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Should have created a checkpoint at index 50
      const state = repository.getState({ untilEventIndex: 50 });
      expect(state).toEqual({ counter: 49 });
    });

    it('should efficiently reconstruct state from checkpoints', async () => {
      await repository.init();

      // Add events up to checkpoint
      for (let i = 0; i < 100; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Getting state at checkpoint should be efficient
      const state = repository.getState({ untilEventIndex: 50 });
      expect(state).toEqual({ counter: 49 });
    });

    it('should handle state reconstruction between checkpoints', async () => {
      await repository.init();

      // Add events to create checkpoint at 50
      for (let i = 0; i < 50; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Add more events after checkpoint
      for (let i = 50; i < 55; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Get state after checkpoint but before next checkpoint
      const state = repository.getState({ untilEventIndex: 53 });
      expect(state).toEqual({ counter: 52 });
    });

    it('should maintain performance with larger event logs', async () => {
      await repository.init();

      // Add a significant number of events to test performance
      for (let i = 0; i < 200; i++) {
        await repository.addEvent({
          type: 'set',
          payload: {
            target: `item.${i}`,
            value: { id: i, name: `Item ${i}`, timestamp: Date.now() }
          }
        });
      }

      // Getting state should still work correctly
      const state = repository.getState();
      expect(Object.keys(state.item)).toHaveLength(200);
      expect(state.item['199']).toEqual({
        id: 199,
        name: 'Item 199',
        timestamp: expect.any(Number)
      });
    });

    it('should handle historical state queries efficiently with checkpoints', async () => {
      await repository.init();

      // Add enough events to create multiple checkpoints
      for (let i = 0; i < 60; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'data.value', value: i }
        });
      }

      // Query different historical states to verify checkpoint functionality
      const earlyState = repository.getState({ untilEventIndex: 10 });
      const middleState = repository.getState({ untilEventIndex: 30 });
      const currentState = repository.getState();

      // Verify that historical states are accessible and different
      expect(earlyState).toBeDefined();
      expect(middleState).toBeDefined();
      expect(currentState).toBeDefined();

      // The current state should have the latest value
      expect(currentState.data.value).toBe(59);

      // Historical states should have different values
      expect(earlyState.data.value).toBeLessThan(middleState.data.value);
      expect(middleState.data.value).toBeLessThan(currentState.data.value);
    });

    it('should handle complex nested state updates efficiently', async () => {
      await repository.init();

      // Add complex nested state updates
      for (let i = 0; i < 100; i++) {
        await repository.addEvent({
          type: 'set',
          payload: {
            target: `users.${i % 10}.profile.settings`,
            value: { theme: i % 2 === 0 ? 'dark' : 'light', notifications: i % 3 }
          }
        });
      }

      const state = repository.getState();

      // Verify the final state is correct
      expect(state.users).toBeDefined();
      expect(Object.keys(state.users)).toHaveLength(10);

      // Check that nested properties are correctly set
      for (let i = 0; i < 10; i++) {
        expect(state.users[i].profile.settings).toBeDefined();
        expect(state.users[i].profile.settings.theme).toMatch(/dark|light/);
      }
    });

    it('should handle multiple event types efficiently', async () => {
      await repository.init();

      // Add different types of events
      for (let i = 0; i < 50; i++) {
        // Set events
        await repository.addEvent({
          type: 'set',
          payload: { target: `data.set${i}`, value: `value${i}` }
        });

        if (i % 10 === 0) {
          // Unset events
          await repository.addEvent({
            type: 'unset',
            payload: { target: `data.set${i - 5}` }
          });
        }
      }

      const state = repository.getState();
      expect(state).toBeDefined();

      // Should have mostly set values with some unset
      const setKeys = Object.keys(state.data).filter(key => key.startsWith('set'));
      expect(setKeys.length).toBeGreaterThan(40);
    });

    it('should maintain checkpoint accuracy with mixed operations', async () => {
      await repository.init();

      // Mix different operations that cross checkpoint boundaries
      for (let i = 0; i < 120; i++) {
        if (i % 3 === 0) {
          await repository.addEvent({
            type: 'set',
            payload: { target: 'counter', value: i }
          });
        } else if (i % 3 === 1) {
          await repository.addEvent({
            type: 'set',
            payload: { target: 'status', value: i % 2 === 0 ? 'active' : 'inactive' }
          });
        } else {
          await repository.addEvent({
            type: 'set',
            payload: { target: 'metadata', value: { step: i, timestamp: Date.now() } }
          });
        }
      }

      // Verify state at different checkpoints
      const stateAt50 = repository.getState({ untilEventIndex: 50 });
      const stateAt100 = repository.getState({ untilEventIndex: 100 });
      const finalState = repository.getState();

      expect(stateAt50).toBeDefined();
      expect(stateAt100).toBeDefined();
      expect(finalState).toBeDefined();

      // Final state should reflect the last operations
      expect(finalState.counter).toBe(117); // Last multiple of 3 before 120
      expect(finalState.status).toBe('active'); // 118 is even, so status is 'active'
    });
  });
});

describe('persistent snapshot functionality', () => {
  describe('backwards compatibility', () => {
    it('should work with stores that do not support snapshots', async () => {
      const mockStore = createMockStore();
      const repository = createRepository({ originStore: mockStore });

      await repository.init();

      // Add some events
      for (let i = 0; i < 10; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      const state = repository.getState();
      expect(state).toEqual({ counter: 9 });
    });

    it('should not call getSnapshot if method does not exist', async () => {
      const mockStore = createMockStore();
      const repository = createRepository({ originStore: mockStore });

      await repository.init();

      // getSnapshot should not exist on basic mock store
      expect(mockStore.getSnapshot).toBeUndefined();
    });

    it('should not call setSnapshot if method does not exist', async () => {
      const mockStore = createMockStore();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 5
      });

      await repository.init();

      // Add events beyond snapshot interval
      for (let i = 0; i < 10; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // setSnapshot should not exist on basic mock store
      expect(mockStore.setSnapshot).toBeUndefined();

      // State should still work correctly
      const state = repository.getState();
      expect(state).toEqual({ counter: 9 });
    });
  });

  describe('initialization with snapshots', () => {
    it('should load snapshot on init if available', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Pre-populate with a snapshot
      mockStore._setSnapshot({
        state: { counter: 100, name: 'test' },
        eventIndex: 50,
        createdAt: Date.now()
      });

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      expect(mockStore.getSnapshot).toHaveBeenCalled();
    });

    it('should ignore snapshot when model version mismatches', async () => {
      const mockStore = createMockStoreWithSnapshots();

      mockStore._setSnapshot({
        state: { counter: 100, name: 'fromSnapshot' },
        eventIndex: 5,
        createdAt: Date.now(),
        modelVersion: 1
      });

      mockStore._setEvents([
        {
          type: 'event',
          payload: { schema: 'counter.set', data: { value: 1 } }
        }
      ]);

      const repository = createRepository({
        originStore: mockStore,
        mode: 'model',
        model: {
          version: 2,
          initialState: {},
          schemas: {
            'counter.set': {
              type: 'object',
              properties: { value: { type: 'number' } },
              required: ['value'],
              additionalProperties: false
            }
          },
          reduce(draft, event) {
            if (event.payload.schema === 'counter.set') {
              draft.counter = event.payload.data.value;
            }
          }
        }
      });

      await repository.init();

      const state = repository.getState();
      expect(state).toEqual({ counter: 1 });
    });

    it('should replay only events since snapshot.eventIndex', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Pre-populate with events
      const allEvents = [];
      for (let i = 0; i < 60; i++) {
        allEvents.push({ type: 'set', payload: { target: 'counter', value: i } });
      }
      mockStore._setEvents(allEvents);

      // Pre-populate with a snapshot at event 50
      mockStore._setSnapshot({
        state: { counter: 49 }, // State after 50 events (0-49)
        eventIndex: 50,
        createdAt: Date.now()
      });

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      // Should use getEvents with 'since' parameter to load only events after snapshot
      expect(mockStore.getEvents).toHaveBeenCalledWith({ since: 50 });

      // Final state should reflect all events
      const state = repository.getState();
      expect(state).toEqual({ counter: 59 });
    });

    it('should use getEvents with since parameter when available', async () => {
      const mockStore = createMockStoreWithSnapshots();

      mockStore._setEvents([
        { type: 'set', payload: { target: 'a', value: 1 } },
        { type: 'set', payload: { target: 'b', value: 2 } },
        { type: 'set', payload: { target: 'c', value: 3 } },
      ]);

      mockStore._setSnapshot({
        state: { a: 1 },
        eventIndex: 1,
        createdAt: Date.now()
      });

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      expect(mockStore.getEvents).toHaveBeenCalledWith({ since: 1 });

      const state = repository.getState();
      expect(state).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should fallback to getEvents + slice when since parameter not supported', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Make getEvents not support 'since' parameter
      mockStore.getEvents.mockImplementation(() => Promise.resolve([...mockStore._getEvents()]));

      mockStore._setEvents([
        { type: 'set', payload: { target: 'a', value: 1 } },
        { type: 'set', payload: { target: 'b', value: 2 } },
        { type: 'set', payload: { target: 'c', value: 3 } },
      ]);

      mockStore._setSnapshot({
        state: { a: 1 },
        eventIndex: 1,
        createdAt: Date.now()
      });

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      // Should call getEvents twice: once with { since: 1 }, once without for fallback
      expect(mockStore.getEvents).toHaveBeenCalled();

      const state = repository.getState();
      expect(state).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should handle null snapshot gracefully', async () => {
      const mockStore = createMockStoreWithSnapshots();

      mockStore._setEvents([
        { type: 'set', payload: { target: 'counter', value: 1 } },
        { type: 'set', payload: { target: 'counter', value: 2 } },
      ]);
      // No snapshot set (null)

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      expect(mockStore.getSnapshot).toHaveBeenCalled();

      // Should fallback to loading all events
      const state = repository.getState();
      expect(state).toEqual({ counter: 2 });
    });

    it('should handle empty events after snapshot', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Snapshot represents all events
      mockStore._setSnapshot({
        state: { counter: 100 },
        eventIndex: 50,
        createdAt: Date.now()
      });

      // No new events since snapshot
      mockStore._setEvents([]);

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      const state = repository.getState();
      expect(state).toEqual({ counter: 100 });
    });
  });

  describe('automatic snapshot saving', () => {
    it('should save snapshot after snapshotInterval events', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 10
      });

      await repository.init();

      // Add exactly snapshotInterval events
      for (let i = 0; i < 10; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      expect(mockStore.setSnapshot).toHaveBeenCalled();

      const savedSnapshot = mockStore._getSnapshot();
      expect(savedSnapshot.state).toEqual({ counter: 9 });
      expect(savedSnapshot.eventIndex).toBe(10);
    });

    it('should respect custom snapshotInterval option', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 5
      });

      await repository.init();

      // Add 4 events - should NOT trigger snapshot
      for (let i = 0; i < 4; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }
      expect(mockStore.setSnapshot).not.toHaveBeenCalled();

      // Add 1 more event (total 5) - should trigger snapshot
      await repository.addEvent({
        type: 'set',
        payload: { target: 'counter', value: 4 }
      });
      expect(mockStore.setSnapshot).toHaveBeenCalled();
    });

    it('should not save snapshot before interval reached', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 100
      });

      await repository.init();

      // Add events below threshold
      for (let i = 0; i < 50; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      expect(mockStore.setSnapshot).not.toHaveBeenCalled();
    });

    it('should track events since last snapshot correctly', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 5
      });

      await repository.init();

      // First batch: 5 events -> snapshot
      for (let i = 0; i < 5; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }
      expect(mockStore.setSnapshot).toHaveBeenCalledTimes(1);

      // Second batch: 5 more events -> second snapshot
      for (let i = 5; i < 10; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }
      expect(mockStore.setSnapshot).toHaveBeenCalledTimes(2);

      const savedSnapshot = mockStore._getSnapshot();
      expect(savedSnapshot.eventIndex).toBe(10);
    });
  });

  describe('manual snapshot saving', () => {
    it('should expose saveSnapshot method', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({ originStore: mockStore });

      expect(repository.saveSnapshot).toBeDefined();
      expect(typeof repository.saveSnapshot).toBe('function');
    });

    it('should save current state and eventIndex', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({ originStore: mockStore });

      await repository.init();

      // Add some events
      for (let i = 0; i < 7; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Manually save snapshot
      await repository.saveSnapshot();

      expect(mockStore.setSnapshot).toHaveBeenCalled();

      const savedSnapshot = mockStore._getSnapshot();
      expect(savedSnapshot.state).toEqual({ counter: 6 });
      expect(savedSnapshot.eventIndex).toBe(7);
      expect(savedSnapshot.createdAt).toBeDefined();
    });

    it('should persist modelVersion in snapshots when provided', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        mode: 'model',
        model: {
          version: 1,
          initialState: {},
          schemas: {
            'counter.set': {
              type: 'object',
              properties: { value: { type: 'number' } },
              required: ['value'],
              additionalProperties: false
            }
          },
          reduce(draft, event) {
            if (event.payload.schema === 'counter.set') {
              draft.counter = event.payload.data.value;
            }
          }
        }
      });

      await repository.init();

      await repository.addEvent({
        type: 'event',
        payload: { schema: 'counter.set', data: { value: 1 } }
      });

      await repository.saveSnapshot();

      const savedSnapshot = mockStore._getSnapshot();
      expect(savedSnapshot.modelVersion).toBe(1);
    });

    it('should be no-op when store does not support snapshots', async () => {
      const mockStore = createMockStore();
      const repository = createRepository({ originStore: mockStore });

      await repository.init();

      await repository.addEvent({
        type: 'set',
        payload: { target: 'counter', value: 1 }
      });

      // Should not throw
      await repository.saveSnapshot();

      // State should still work
      const state = repository.getState();
      expect(state).toEqual({ counter: 1 });
    });
  });

  describe('state correctness with snapshots', () => {
    it('should produce identical state with and without snapshot', async () => {
      // Create events list
      const events = [];
      for (let i = 0; i < 100; i++) {
        events.push({ type: 'set', payload: { target: `key${i}`, value: i } });
      }

      // Repository WITHOUT snapshot
      const storeWithout = createMockStore();
      storeWithout.getEvents.mockResolvedValue([...events]);
      const repoWithout = createRepository({ originStore: storeWithout });
      await repoWithout.init();
      const stateWithout = repoWithout.getState();

      // Repository WITH snapshot at event 50
      const storeWith = createMockStoreWithSnapshots();
      storeWith._setEvents([...events]);

      // Compute expected state at event 50
      let stateAt50 = {};
      for (let i = 0; i < 50; i++) {
        stateAt50[`key${i}`] = i;
      }
      storeWith._setSnapshot({
        state: stateAt50,
        eventIndex: 50,
        createdAt: Date.now()
      });

      const repoWith = createRepository({ originStore: storeWith });
      await repoWith.init();
      const stateWith = repoWith.getState();

      // States should be identical
      expect(stateWith).toEqual(stateWithout);
    });

    it('should maintain correct state after multiple init cycles', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // First init - add events
      const repository1 = createRepository({
        originStore: mockStore,
        snapshotInterval: 5
      });
      await repository1.init();

      for (let i = 0; i < 7; i++) {
        await repository1.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      const state1 = repository1.getState();

      // Second init - should load from snapshot + replay new events
      const repository2 = createRepository({
        originStore: mockStore,
        snapshotInterval: 5
      });
      await repository2.init();

      const state2 = repository2.getState();

      expect(state2).toEqual(state1);
      expect(state2).toEqual({ counter: 6 });
    });

    it('should handle checkpoint indexes correctly after snapshot load', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Set up with snapshot
      mockStore._setSnapshot({
        state: { counter: 49 },
        eventIndex: 50,
        createdAt: Date.now()
      });

      // Set up full event history (events 0-79)
      const allEvents = [];
      for (let i = 0; i < 80; i++) {
        allEvents.push({ type: 'set', payload: { target: 'counter', value: i } });
      }
      mockStore._setEvents(allEvents);

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      // Query historical state - should work correctly with checkpoint system
      const stateAt60 = repository.getState({ untilEventIndex: 60 });
      expect(stateAt60).toEqual({ counter: 59 });

      const stateAt75 = repository.getState({ untilEventIndex: 75 });
      expect(stateAt75).toEqual({ counter: 74 });

      const currentState = repository.getState();
      expect(currentState).toEqual({ counter: 79 });
    });
  });

  describe('edge cases', () => {
    it('should handle snapshot at event 0', async () => {
      const mockStore = createMockStoreWithSnapshots();

      mockStore._setSnapshot({
        state: {},
        eventIndex: 0,
        createdAt: Date.now()
      });

      mockStore._setEvents([
        { type: 'set', payload: { target: 'a', value: 1 } },
      ]);

      const repository = createRepository({ originStore: mockStore });
      await repository.init();

      const state = repository.getState();
      expect(state).toEqual({ a: 1 });
    });

    it('should handle snapshot with exactly snapshotInterval events since last', async () => {
      const mockStore = createMockStoreWithSnapshots();
      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 10
      });

      await repository.init();

      // Add exactly 10 events
      for (let i = 0; i < 10; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Should have saved exactly once
      expect(mockStore.setSnapshot).toHaveBeenCalledTimes(1);

      // Add 10 more
      for (let i = 10; i < 20; i++) {
        await repository.addEvent({
          type: 'set',
          payload: { target: 'counter', value: i }
        });
      }

      // Should have saved twice total
      expect(mockStore.setSnapshot).toHaveBeenCalledTimes(2);
    });

    it('should handle init with initialState and existing snapshot', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // Snapshot exists
      mockStore._setSnapshot({
        state: { fromSnapshot: true },
        eventIndex: 5,
        createdAt: Date.now()
      });

      const repository = createRepository({ originStore: mockStore });

      // init with initialState - should be ignored since snapshot exists
      await repository.init({ initialState: { fromInitial: true } });

      const state = repository.getState();
      // Should use snapshot state, not initialState
      expect(state).toEqual({ fromSnapshot: true });
    });

    it('should save snapshot on init if many events replayed', async () => {
      const mockStore = createMockStoreWithSnapshots();

      // No snapshot, but many events
      const events = [];
      for (let i = 0; i < 25; i++) {
        events.push({ type: 'set', payload: { target: 'counter', value: i } });
      }
      mockStore._setEvents(events);

      const repository = createRepository({
        originStore: mockStore,
        snapshotInterval: 10
      });
      await repository.init();

      // Should have saved snapshot after replaying events
      expect(mockStore.setSnapshot).toHaveBeenCalled();

      const savedSnapshot = mockStore._getSnapshot();
      expect(savedSnapshot.eventIndex).toBe(25);
    });
  });

  describe('model event envelope', () => {
    let mockStore;

    beforeEach(() => {
      mockStore = createMockStore();
    });

    it('should apply model events when model is provided', async () => {
      const model = {
        initialState: { branches: { items: {}, tree: [] } },
        schemas: {
          'branch.create': {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              desc: { type: 'string' }
            },
            required: ['name'],
            additionalProperties: false
          }
        },
        reduce(draft, event) {
          const { schema, data } = event.payload;
          if (schema === 'branch.create') {
            draft.branches.items[data.name] = { desc: data.desc || '' };
            draft.branches.tree.push({ id: data.name, children: [] });
            return;
          }
        }
      };

      const repository = createRepository({ originStore: mockStore, mode: 'model', model });
      await repository.init();

      await repository.addEvent({
        type: 'event',
        payload: {
          schema: 'branch.create',
          data: { name: 'feature-x', desc: 'test' }
        },
        partition: 'branch/feature-x'
      });

      const state = repository.getState();
      expect(state.branches.items['feature-x']).toEqual({ desc: 'test' });
      expect(state.branches.tree[0]).toEqual({ id: 'feature-x', children: [] });
    });

    it('should reject model events when no model is configured', async () => {
      const repository = createRepository({ originStore: mockStore, mode: 'tree' });
      await repository.init();

      await expect(repository.addEvent({
        type: 'event',
        payload: {
          schema: 'branch.create',
          data: { name: 'feature-x' }
        }
      })).rejects.toThrow('Tree mode does not accept type "event".');
    });

    it('should reject model events with unknown schema', async () => {
      const model = {
        initialState: { branches: { items: {}, tree: [] } },
        schemas: {},
        reduce() {}
      };

      const repository = createRepository({ originStore: mockStore, mode: 'model', model });
      await repository.init();

      await expect(repository.addEvent({
        type: 'event',
        payload: {
          schema: 'branch.create',
          data: { name: 'feature-x' }
        }
      })).rejects.toThrow('unknown schema');
    });

    it('should reject non-event types in model mode', async () => {
      const model = {
        initialState: {},
        schemas: {},
        reduce() {}
      };

      const repository = createRepository({ originStore: mockStore, mode: 'model', model });
      await repository.init();

      await expect(repository.addEvent({
        type: 'set',
        payload: { target: 'x', value: 1 }
      })).rejects.toThrow('Model mode only accepts type "event".');
    });
  });
});
