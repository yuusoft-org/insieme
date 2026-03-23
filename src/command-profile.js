import {
  cloneObject,
  isNonEmptyString,
  isObject,
  normalizeMeta,
  toFiniteNumberOrNull,
  toPositiveIntegerOrNull,
} from "./event-record.js";
const failValidation = (message, details = {}) => {
  const error = new Error(message);
  error.code = "validation_failed";
  error.details = details;
  throw error;
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
 *   schemaVersion?: number,
 * }} command
 * @param {{ defaultSchemaVersion?: number }} [options]
 */
export const commandToSyncEvent = (
  command,
  { defaultSchemaVersion } = {},
) => {
  const meta = cloneObject(command?.meta, {});
  if (command?.actor?.clientId !== undefined) {
    meta.clientId = command.actor.clientId;
  }
  if (command?.clientTs !== undefined) {
    meta.clientTs = command.clientTs;
  }

  return {
    partition: isNonEmptyString(command?.partition)
      ? command.partition
      : undefined,
    projectId: command.projectId,
    userId: command?.actor?.userId,
    type: command.type,
    schemaVersion:
      toPositiveIntegerOrNull(command?.schemaVersion) ??
      toPositiveIntegerOrNull(defaultSchemaVersion) ??
      undefined,
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
 *   partition?: string,
 *   type?: string,
 *   schemaVersion?: number,
 *   payload?: object,
 *   meta?: object,
 *   serverTs?: number,
 * }} committedEvent
 */
export const committedSyncEventToCommand = (committedEvent) => {
  if (
    !isNonEmptyString(committedEvent?.id) ||
    !isNonEmptyString(committedEvent?.type) ||
    !isObject(committedEvent?.payload) ||
    toPositiveIntegerOrNull(committedEvent?.schemaVersion) === null
  ) {
    return null;
  }

  const partition = isNonEmptyString(committedEvent?.partition)
    ? committedEvent.partition
    : undefined;
  const meta = normalizeMeta(committedEvent?.meta);
  const fallbackClientTs = toFiniteNumberOrNull(committedEvent?.serverTs);

  return {
    id: committedEvent.id,
    projectId: isNonEmptyString(committedEvent?.projectId)
      ? committedEvent.projectId
      : undefined,
    partition,
    type: committedEvent.type,
    schemaVersion: committedEvent.schemaVersion,
    payload: structuredClone(committedEvent.payload),
    meta: structuredClone(meta),
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
 *   partition?: string,
 *   projectId?: string,
 *   userId?: string,
 *   type?: string,
 *   schemaVersion?: number,
 *   payload?: object,
 *   meta?: object,
 * }} item
 */
export const validateCommandSubmitItem = (item) => {
  if (!isObject(item)) {
    failValidation("submit item is required");
  }
  if (!isNonEmptyString(item.partition)) {
    failValidation("item.partition is required");
  }

  if (!isNonEmptyString(item.id)) {
    failValidation("item.id is required");
  }
  if (!isNonEmptyString(item.type)) {
    failValidation("item.type is required");
  }
  if (toPositiveIntegerOrNull(item.schemaVersion) === null) {
    failValidation("item.schemaVersion must be a positive integer");
  }
  if (!isObject(item.payload)) {
    failValidation("item.payload is required");
  }
  if (item.userId !== undefined && !isNonEmptyString(item.userId)) {
    failValidation("item.userId must be a non-empty string when provided");
  }

  if (!isNonEmptyString(item.projectId)) {
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
    projectId: item.projectId,
    userId: item.userId,
    partition: item.partition,
    schemaVersion: item.schemaVersion,
    meta,
  };
};
