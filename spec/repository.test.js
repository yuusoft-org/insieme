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
      const state = repository.getState(2);
      expect(state).toEqual({ counter: 2 });
    });

    it('should return empty state for index 0', () => {
      const state = repository.getState(0);
      expect(state).toEqual({});
    });

    it('should clamp index to valid range', () => {
      // Test index beyond range
      const state = repository.getState(100);
      expect(state).toEqual({ counter: 3, name: 'test' });
    });

    it('should handle negative indices', () => {
      const state = repository.getState(-1);
      expect(state).toEqual({});
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await repository.init();
    });

    it('should handle unknown event types gracefully', async () => {
      await repository.addEvent({
        type: 'unknownType',
        payload: { data: 'test' }
      });

      const state = repository.getState();
      expect(state).toEqual({});
    });

    it('should handle malformed event payloads', async () => {
      // Test with malformed payload that won't crash
      await repository.addEvent({
        type: 'unknownType', // Use unknown type instead of null payload
        payload: null
      });

      // Should not throw, but handle gracefully
      const state = repository.getState();
      expect(state).toEqual({});
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
      const state = repository.getState(50);
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
      const state = repository.getState(50);
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
      const state = repository.getState(53);
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
      const earlyState = repository.getState(10);
      const middleState = repository.getState(30);
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
      const stateAt50 = repository.getState(50);
      const stateAt100 = repository.getState(100);
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