const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

const toUniqueNonEmptyStrings = (values = []) =>
  [...new Set(values.filter((value) => isNonEmptyString(value)))];

const failValidation = (message, details = {}) => {
  const error = new Error(message);
  error.code = "validation_failed";
  error.details = details;
  throw error;
};

/**
 * @param {string[]} partitions
 */
export const projectIdFromPartitions = (partitions = []) => {
  for (const partition of partitions) {
    const projectId = extractScopeId(partition, "project");
    if (projectId) return projectId;
  }
  return null;
};

/**
 * Convert an app command envelope to Insieme sync event envelope.
 *
 * @param {{
 *   id: string,
 *   type: string,
 *   payload: object,
 *   actor: { userId: string, clientId: string },
 *   projectId?: string,
 *   clientTs: number,
 *   commandVersion?: number,
 * }} command
 */
export const commandToSyncEvent = (command) => ({
  type: "event",
  payload: {
    commandId: command.id,
    schema: command.type,
    data: structuredClone(command.payload),
    commandVersion: command.commandVersion,
    actor: structuredClone(command.actor),
    projectId: command.projectId,
    clientTs: command.clientTs,
  },
});

/**
 * Convert committed sync event row to app command envelope.
 *
 * @param {{
 *   id: string,
 *   client_id?: string,
 *   project_id?: string,
 *   partitions?: string[],
 *   event?: { type?: string, payload?: object },
 *   status_updated_at?: number,
 * }} committedEvent
 * @param {{ defaultCommandVersion?: number }} [options]
 */
export const committedSyncEventToCommand = (
  committedEvent,
  { defaultCommandVersion = 1 } = {},
) => {
  const payload = committedEvent?.event?.payload;
  if (!isObject(payload) || committedEvent?.event?.type !== "event") {
    return null;
  }

  const schema = payload.schema;
  const data = payload.data;
  if (!isNonEmptyString(schema) || !isObject(data)) {
    return null;
  }

  const partitions = toUniqueNonEmptyStrings(
    Array.isArray(committedEvent?.partitions) ? committedEvent.partitions : [],
  );
  const resolvedProjectId =
    payload.projectId ||
    committedEvent?.project_id ||
    projectIdFromPartitions(partitions);

  return {
    id: isNonEmptyString(payload.commandId) ? payload.commandId : committedEvent.id,
    projectId: resolvedProjectId,
    partition: partitions[0],
    partitions,
    type: schema,
    payload: structuredClone(data),
    commandVersion: payload.commandVersion ?? defaultCommandVersion,
    actor: payload.actor || {
      userId: "unknown",
      clientId: committedEvent?.client_id,
    },
    clientTs: payload.clientTs || committedEvent?.status_updated_at,
  };
};

/**
 * Validate submit item in command profile (`event.type === "event"` payload shape).
 *
 * @param {{
 *   id?: string,
 *   clientId?: string,
 *   partitions?: string[],
 *   event?: { type?: string, payload?: object },
   * }} item
 */
export const validateCommandSubmitItem = (item) => {
  if (!isObject(item)) {
    failValidation("event envelope is required");
  }
  if (!isObject(item.event)) {
    failValidation("item.event is required");
  }
  if (!Array.isArray(item.partitions) || item.partitions.length === 0) {
    failValidation("partitions are required");
  }

  const partitions = toUniqueNonEmptyStrings(item.partitions);
  if (partitions.length === 0) {
    failValidation("partitions must include at least one non-empty string");
  }

  const event = item.event;
  if (event.type !== "event") {
    failValidation(`Unsupported item.event.type: ${event.type}`);
  }

  const payload = event.payload;
  if (!isObject(payload)) {
    failValidation("item.event.payload is required");
  }
  if (!isNonEmptyString(payload.commandId)) {
    failValidation("event.payload.commandId is required");
  }
  if (!isNonEmptyString(payload.schema)) {
    failValidation("event.payload.schema is required");
  }
  if (!isObject(payload.data)) {
    failValidation("event.payload.data is required");
  }

  const projectId =
    payload.projectId || projectIdFromPartitions(partitions);
  if (!isNonEmptyString(projectId)) {
    failValidation("event.payload.projectId is required");
  }

  if (!Number.isFinite(Number(payload.clientTs))) {
    failValidation("event.payload.clientTs must be a finite number");
  }

  if (!isObject(payload.actor)) {
    failValidation("actor is required");
  }
  if (!isNonEmptyString(payload.actor.userId)) {
    failValidation("actor.userId is required");
  }
  if (!isNonEmptyString(payload.actor.clientId)) {
    failValidation("actor.clientId is required");
  }

  return {
    commandId: payload.commandId,
    schema: payload.schema,
    projectId,
    partitions,
  };
};
import { extractScopeId } from "./partition-scope.js";
