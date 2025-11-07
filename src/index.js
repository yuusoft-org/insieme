/**
 * Insieme - Foundational library for building collaborative, consistent state
 *
 * This is the main entry point for the Insieme library, providing exports for:
 * - Repository factory functions for different environments
 * - Core actions for state manipulation
 * - Helper functions for tree data structure operations
 */

// Repository factories
export {
  createRepositoryFactory,
  createWebRepositoryFactory
} from './insieme.js';

// Core actions
export {
  set,
  unset,
  treePush,
  treeDelete,
  treeUpdate,
  treeMove
} from './actions.js';

// Helper functions for tree operations
export {
  toFlatItems,
  toFlatGroups,
  toTreeStructure
} from './helpers.js';