import {
  cloneObject,
  isNonEmptyString,
  isObject,
  normalizeMeta,
  toFiniteNumberOrNull,
} from "./event-record.js";
import { extractScopeId } from "./partition-scope.js";

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
 * Convert an app command envelope to normalized sync submit fields.
 *
 * @param {{
 *   id: string,
 *   type: string,
 *   payload: object,
 *   meta?: object,
 *   actor: { userId?: string, clientId: string },
 *   projectId?: string,
 *   clientTs: number,
 * }} command
 */
export const commandToSyncEvent = (command) => {
  const meta = cloneObject(command?.meta, {});
  if (command?.actor?.clientId !== undefined) {
    meta.clientId = command.actor.clientId;
  }
  if (command?.clientTs !== undefined) {
    meta.clientTs = command.clientTs;
  }

  return {
    projectId: command.projectId,
    userId: command?.actor?.userId,
    type: command.type,
    payload: structuredClone(command.payload),
    meta: normalizeMeta(meta, {
      defaultClientId: command?.actor?.clientId,
      defaultClientTs: command?.clientTs,
    }),
  };
};

/**
 * Convert committed sync row to app command envelope.
 *
 * @param {{
 *   id: string,
 *   projectId?: string,
 *   userId?: string,
 *   partitions?: string[],
 *   type?: string,
 *   payload?: object,
 *   meta?: object,
 *   created?: number,
 * }} committedEvent
 * @param {{ defaultCommandVersion?: number }} [options]
 */
export const committedSyncEventToCommand = (
  committedEvent,
  { defaultCommandVersion = 1 } = {},
) => {
  if (
    !isNonEmptyString(committedEvent?.id) ||
    !isNonEmptyString(committedEvent?.type) ||
    !isObject(committedEvent?.payload)
  ) {
    return null;
  }

  const partitions = toUniqueNonEmptyStrings(
    Array.isArray(committedEvent?.partitions) ? committedEvent.partitions : [],
  );
  const resolvedProjectId =
    committedEvent?.projectId || projectIdFromPartitions(partitions);
  const meta = normalizeMeta(committedEvent?.meta);
  const fallbackClientTs = toFiniteNumberOrNull(committedEvent?.created);

  return {
    id: committedEvent.id,
    projectId: resolvedProjectId,
    partition: partitions[0],
    partitions,
    type: committedEvent.type,
    payload: structuredClone(committedEvent.payload),
    meta: structuredClone(meta),
    commandVersion: defaultCommandVersion,
    actor: {
      userId: isNonEmptyString(committedEvent?.userId)
        ? committedEvent.userId
        : undefined,
      clientId: isNonEmptyString(meta.clientId) ? meta.clientId : undefined,
    },
    clientTs: toFiniteNumberOrNull(meta.clientTs) ?? fallbackClientTs,
  };
};

/**
 * Validate submit item in the normalized command profile.
 *
 * @param {{
 *   id?: string,
 *   partitions?: string[],
 *   projectId?: string,
 *   userId?: string,
 *   type?: string,
 *   payload?: object,
 *   meta?: object,
 * }} item
 */
export const validateCommandSubmitItem = (item) => {
  if (!isObject(item)) {
    failValidation("submit item is required");
  }
  if (!Array.isArray(item.partitions) || item.partitions.length === 0) {
    failValidation("partitions are required");
  }

  const partitions = toUniqueNonEmptyStrings(item.partitions);
  if (partitions.length === 0) {
    failValidation("partitions must include at least one non-empty string");
  }

  if (!isNonEmptyString(item.id)) {
    failValidation("item.id is required");
  }
  if (!isNonEmptyString(item.type)) {
    failValidation("item.type is required");
  }
  if (!isObject(item.payload)) {
    failValidation("item.payload is required");
  }
  if (item.userId !== undefined && !isNonEmptyString(item.userId)) {
    failValidation("item.userId must be a non-empty string when provided");
  }

  const projectId = item.projectId || projectIdFromPartitions(partitions);
  if (!isNonEmptyString(projectId)) {
    failValidation("item.projectId is required");
  }

  const meta = normalizeMeta(item.meta);
  if (!isNonEmptyString(meta.clientId)) {
    failValidation("item.meta.clientId is required");
  }
  if (toFiniteNumberOrNull(meta.clientTs) === null) {
    failValidation("item.meta.clientTs must be a finite number");
  }

  return {
    commandId: item.id,
    type: item.type,
    projectId,
    userId: item.userId,
    partitions,
    meta,
  };
};
