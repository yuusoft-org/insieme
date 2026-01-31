import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

/**
 * Default JSON schemas for each event type
 */
const schemas = {
  set: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
      value: {},
      options: {
        type: "object",
        properties: { replace: { type: "boolean" } },
        additionalProperties: false,
      },
    },
    required: ["target", "value"],
    additionalProperties: false,
  },
  unset: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
    },
    required: ["target"],
    additionalProperties: false,
  },
  treePush: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
      value: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
      options: { type: "object" },
    },
    required: ["target", "value"],
    additionalProperties: false,
  },
  treeDelete: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
      options: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
    },
    required: ["target", "options"],
    additionalProperties: false,
  },
  treeUpdate: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
      value: { type: "object" },
      options: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          replace: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    required: ["target", "value", "options"],
    additionalProperties: false,
  },
  treeMove: {
    type: "object",
    properties: {
      target: { type: "string", minLength: 1 },
      options: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
    },
    required: ["target", "options"],
    additionalProperties: false,
  },
  init: {
    type: "object",
    properties: {
      value: {},
    },
    required: ["value"],
    additionalProperties: false,
  },
};

/**
 * Compile validators once at module load
 * @type {Record<string, import('ajv').ValidateFunction>}
 */
const validators = Object.fromEntries(
  Object.entries(schemas).map(([type, schema]) => [type, ajv.compile(schema)]),
);

const eventEnvelopeSchema = {
  type: "object",
  properties: {
    schema: { type: "string", minLength: 1 },
    data: {},
    meta: { type: "object" },
  },
  required: ["schema", "data"],
  additionalProperties: false,
};

const eventEnvelopeValidator = ajv.compile(eventEnvelopeSchema);

const domainValidatorCache = new WeakMap();

/**
 * Custom error class for event validation failures
 */
export class EventValidationError extends Error {
  /**
   * @param {string} eventType - The type of event that failed validation
   * @param {import('ajv').ErrorObject[]} errors - The validation errors from ajv
   */
  constructor(eventType, errors) {
    const details = errors
      .map((e) => `${e.instancePath || "payload"} ${e.message}`)
      .join("; ");
    super(`Event validation failed for type "${eventType}": ${details}`);
    this.name = "EventValidationError";
    /** @type {string} */
    this.eventType = eventType;
    /** @type {import('ajv').ErrorObject[]} */
    this.validationErrors = errors;
  }
}

/**
 * Validates an event payload against the schema for its type
 *
 * @param {string} eventType - The type of event (set, unset, treePush, etc.)
 * @param {unknown} payload - The event payload to validate
 * @throws {EventValidationError} If the payload does not match the schema
 */
export const validateEventPayload = (eventType, payload) => {
  if (eventType === "event") {
    validateEventEnvelope(payload);
    return;
  }

  const validator = validators[eventType];
  if (!validator) {
    throw new EventValidationError(eventType, [
      { instancePath: "type", message: "unknown event type" },
    ]);
  }

  if (!validator(payload)) {
    throw new EventValidationError(eventType, validator.errors);
  }
};

/**
 * Validates the event envelope for domain events (type === "event").
 *
 * @param {unknown} payload - The event payload to validate
 * @throws {EventValidationError} If the payload does not match the envelope schema
 */
export const validateEventEnvelope = (payload) => {
  if (!eventEnvelopeValidator(payload)) {
    throw new EventValidationError("event", eventEnvelopeValidator.errors);
  }
};

/**
 * Validates a domain event payload against a provided schema registry.
 *
 * @param {string} schemaId - Schema identifier (e.g., "branch.create@v1")
 * @param {unknown} data - The domain event payload to validate
 * @param {Record<string, object>} schemas - Schema registry
 * @throws {EventValidationError} If schema is missing or payload invalid
 */
export const validateDomainEvent = (schemaId, data, schemas) => {
  if (!schemas || typeof schemas !== "object") {
    throw new Error("Domain schemas registry is required for type \"event\".");
  }

  const schema = schemas[schemaId];
  if (!schema) {
    throw new EventValidationError(schemaId, [
      { instancePath: "payload.schema", message: "unknown schema" },
    ]);
  }

  let registryCache = domainValidatorCache.get(schemas);
  if (!registryCache) {
    registryCache = new Map();
    domainValidatorCache.set(schemas, registryCache);
  }

  let validator = registryCache.get(schemaId);
  if (!validator) {
    validator = ajv.compile(schema);
    registryCache.set(schemaId, validator);
  }

  if (!validator(data)) {
    throw new EventValidationError(schemaId, validator.errors);
  }
};

/**
 * Test helper for validating event payloads
 * Returns true if valid, throws EventValidationError if invalid
 *
 * @param {string} eventType - The type of event (set, unset, treePush, etc.)
 * @param {unknown} payload - The event payload to validate
 * @returns {boolean} true if validation passes
 * @throws {EventValidationError} If the payload does not match the schema
 */
export const testValidateEventPayload = (eventType, payload) => {
  validateEventPayload(eventType, payload);
  return true;
};

/**
 * Test helper for validating event envelopes
 * Returns true if valid, throws EventValidationError if invalid
 *
 * @param {unknown} payload - The envelope payload to validate
 * @returns {boolean} true if validation passes
 * @throws {EventValidationError} If the payload does not match the envelope schema
 */
export const testValidateEventEnvelope = (payload) => {
  validateEventEnvelope(payload);
  return true;
};

/**
 * Test helper for validating domain events
 * Returns true if valid, throws EventValidationError if invalid
 *
 * @param {string} schemaId - Schema identifier
 * @param {unknown} data - Domain payload
 * @param {Record<string, object>} schemas - Schema registry
 * @returns {boolean} true if validation passes
 * @throws {EventValidationError} If the payload does not match the schema
 */
export const testValidateDomainEvent = (schemaId, data, schemas) => {
  validateDomainEvent(schemaId, data, schemas);
  return true;
};
