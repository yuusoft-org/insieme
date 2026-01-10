/**
 * Unit tests for event payload validation
 * Tests JSON schema validation for all event types
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRepository } from "../src/repository.js";
import { EventValidationError } from "../src/validation.js";

// Mock store implementation for testing
const createMockStore = () => {
  let events = [];
  return {
    getEvents: vi.fn().mockImplementation(() => Promise.resolve([...events])),
    appendEvent: vi.fn().mockImplementation((event) => {
      events.push(event);
      return Promise.resolve();
    }),
    clearEvents: vi.fn().mockImplementation(() => {
      events = [];
    }),
  };
};

describe("Event validation", () => {
  let mockStore;
  let repository;

  beforeEach(async () => {
    mockStore = createMockStore();
    repository = createRepository({ originStore: mockStore });
    await repository.init();
  });

  describe("set event validation", () => {
    it("should accept valid set event", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user.name", value: "Alice" },
        }),
      ).resolves.not.toThrow();
    });

    it("should accept set event with options", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user", value: { name: "Alice" }, options: { replace: true } },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject set event with missing target", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { value: "Alice" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject set event with empty target", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "", value: "Alice" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject set event with missing value", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user.name" },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("unset event validation", () => {
    it("should accept valid unset event", async () => {
      await expect(
        repository.addEvent({
          type: "unset",
          payload: { target: "user.name" },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject unset event with missing target", async () => {
      await expect(
        repository.addEvent({
          type: "unset",
          payload: {},
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("treePush event validation", () => {
    it("should accept valid treePush event", async () => {
      await repository.addEvent({
        type: "set",
        payload: { target: "explorer", value: {} },
      });

      await expect(
        repository.addEvent({
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "folder1", name: "Folder" },
          },
        }),
      ).resolves.not.toThrow();
    });

    it("should accept treePush with options", async () => {
      await repository.addEvent({
        type: "set",
        payload: { target: "explorer", value: {} },
      });

      await expect(
        repository.addEvent({
          type: "treePush",
          payload: {
            target: "explorer",
            value: { id: "folder1" },
            options: { parent: "_root", position: "first" },
          },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject treePush without id in value", async () => {
      await expect(
        repository.addEvent({
          type: "treePush",
          payload: {
            target: "explorer",
            value: { name: "Folder" },
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treePush with missing target", async () => {
      await expect(
        repository.addEvent({
          type: "treePush",
          payload: {
            value: { id: "folder1" },
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("treeDelete event validation", () => {
    it("should accept valid treeDelete event", async () => {
      await repository.addEvent({
        type: "set",
        payload: { target: "explorer", value: { items: { folder1: {} }, tree: [{ id: "folder1" }] } },
      });

      await expect(
        repository.addEvent({
          type: "treeDelete",
          payload: {
            target: "explorer",
            options: { id: "folder1" },
          },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject treeDelete with missing options", async () => {
      await expect(
        repository.addEvent({
          type: "treeDelete",
          payload: { target: "explorer" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treeDelete with missing id in options", async () => {
      await expect(
        repository.addEvent({
          type: "treeDelete",
          payload: {
            target: "explorer",
            options: {},
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("treeUpdate event validation", () => {
    it("should accept valid treeUpdate event", async () => {
      await repository.addEvent({
        type: "set",
        payload: { target: "explorer", value: { items: { folder1: { name: "Old" } }, tree: [{ id: "folder1" }] } },
      });

      await expect(
        repository.addEvent({
          type: "treeUpdate",
          payload: {
            target: "explorer",
            value: { name: "New" },
            options: { id: "folder1" },
          },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject treeUpdate with missing value", async () => {
      await expect(
        repository.addEvent({
          type: "treeUpdate",
          payload: {
            target: "explorer",
            options: { id: "folder1" },
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treeUpdate with missing options", async () => {
      await expect(
        repository.addEvent({
          type: "treeUpdate",
          payload: {
            target: "explorer",
            value: { name: "New" },
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("treeMove event validation", () => {
    it("should accept valid treeMove event", async () => {
      await repository.addEvent({
        type: "set",
        payload: {
          target: "explorer",
          value: { items: { folder1: {}, folder2: {} }, tree: [{ id: "folder1" }, { id: "folder2" }] },
        },
      });

      await expect(
        repository.addEvent({
          type: "treeMove",
          payload: {
            target: "explorer",
            options: { id: "folder1", parent: "folder2" },
          },
        }),
      ).resolves.not.toThrow();
    });

    it("should reject treeMove with missing options", async () => {
      await expect(
        repository.addEvent({
          type: "treeMove",
          payload: { target: "explorer" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treeMove with missing id in options", async () => {
      await expect(
        repository.addEvent({
          type: "treeMove",
          payload: {
            target: "explorer",
            options: { parent: "folder2" },
          },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("EventValidationError", () => {
    it("should have correct error properties", async () => {
      try {
        await repository.addEvent({
          type: "set",
          payload: { value: "Alice" },
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(EventValidationError);
        expect(error.name).toBe("EventValidationError");
        expect(error.eventType).toBe("set");
        expect(error.validationErrors).toBeDefined();
        expect(Array.isArray(error.validationErrors)).toBe(true);
        expect(error.validationErrors.length).toBeGreaterThan(0);
        expect(error.message).toContain("set");
        expect(error.message).toContain("target");
      }
    });
  });

  describe("additional properties rejection", () => {
    it("should reject set event with unknown properties", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user.name", value: "Alice", unknownProp: "bad" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject unset event with unknown properties", async () => {
      await expect(
        repository.addEvent({
          type: "unset",
          payload: { target: "user.name", extraField: true },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treePush event with unknown properties", async () => {
      await expect(
        repository.addEvent({
          type: "treePush",
          payload: { target: "explorer", value: { id: "f1" }, badProp: 123 },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject set options with unknown properties", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user", value: {}, options: { replace: true, unknown: "x" } },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });

  describe("wrong type rejection", () => {
    it("should reject set event with target as number", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: 123, value: "Alice" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject set event with target as null", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: null, value: "Alice" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject unset event with target as object", async () => {
      await expect(
        repository.addEvent({
          type: "unset",
          payload: { target: { path: "user" } },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treePush event with value as string", async () => {
      await expect(
        repository.addEvent({
          type: "treePush",
          payload: { target: "explorer", value: "not-an-object" },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treePush event with id as number", async () => {
      await expect(
        repository.addEvent({
          type: "treePush",
          payload: { target: "explorer", value: { id: 123 } },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject treeUpdate event with value as array", async () => {
      await expect(
        repository.addEvent({
          type: "treeUpdate",
          payload: { target: "explorer", value: ["not", "object"], options: { id: "f1" } },
        }),
      ).rejects.toThrow(EventValidationError);
    });

    it("should reject set options.replace as string", async () => {
      await expect(
        repository.addEvent({
          type: "set",
          payload: { target: "user", value: {}, options: { replace: "yes" } },
        }),
      ).rejects.toThrow(EventValidationError);
    });
  });
});
