import {
  canonicalizeSubmitItem,
  normalizePartitionSet,
} from "./canonicalize.js";
import {
  isNonEmptyString,
  isObject,
  normalizeMeta,
  toFiniteNumberOrNull,
  toPositiveIntegerOrNull,
} from "./event-record.js";
import {
  buildProjectScopePartition,
  extractProjectScopeIds,
} from "./partition-scope.js";

const safeJsonParse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const parseStoredPartitions = (value) =>
  normalizePartitionSet(
    typeof value === "string" ? safeJsonParse(value, []) : value,
  );

export const parseStoredEvent = (value) => {
  const parsed = typeof value === "string" ? safeJsonParse(value, {}) : value;
  return isObject(parsed) ? parsed : {};
};

export const getStoredCommittedId = (event) =>
  toFiniteNumberOrNull(event?.committed_id) ??
  toFiniteNumberOrNull(event?.committedId) ??
  0;

export const getStoredStatusUpdatedAt = (event) =>
  toFiniteNumberOrNull(event?.status_updated_at) ??
  toFiniteNumberOrNull(event?.serverTs) ??
  toFiniteNumberOrNull(event?.createdAt) ??
  0;

export const getStoredCreatedAt = (event) =>
  toFiniteNumberOrNull(event?.createdAt) ??
  toFiniteNumberOrNull(event?.created_at) ??
  getStoredStatusUpdatedAt(event);

export const getStoredClientId = (event, fallback) =>
  isNonEmptyString(event?.client_id)
    ? event.client_id
    : isNonEmptyString(event?.clientId)
      ? event.clientId
      : isNonEmptyString(event?.meta?.clientId)
        ? event.meta.clientId
        : fallback;

export const getStoredPartitions = (event) => {
  if (Array.isArray(event?.partitions)) {
    return normalizePartitionSet(event.partitions);
  }
  const partition = isNonEmptyString(event?.partition)
    ? event.partition
    : isNonEmptyString(event?.__storedPartition)
      ? event.__storedPartition
      : undefined;
  const projectId = isNonEmptyString(event?.projectId)
    ? event.projectId
    : isNonEmptyString(event?.__storedProjectId)
      ? event.__storedProjectId
      : undefined;
  return normalizePartitionSet([projectId, partition].filter(isNonEmptyString));
};

export const getStoredDomainEvent = (event) => {
  if (isObject(event?.event)) {
    const domainEvent = structuredClone(event.event);
    if (
      domainEvent.type === "event" &&
      isObject(domainEvent.payload) &&
      toPositiveIntegerOrNull(domainEvent.payload.schemaVersion) === null &&
      toPositiveIntegerOrNull(domainEvent.schemaVersion) !== null
    ) {
      domainEvent.payload.schemaVersion = domainEvent.schemaVersion;
      delete domainEvent.schemaVersion;
    }
    return domainEvent;
  }

  if (isNonEmptyString(event?.type) && isObject(event?.payload)) {
    return {
      type: "event",
      payload: {
        schema: event.type,
        schemaVersion: toPositiveIntegerOrNull(event.schemaVersion) ?? 1,
        data: structuredClone(event.payload),
      },
    };
  }

  return {
    type: "event",
    payload: {
      schema: "event",
      data: {},
    },
  };
};

const ownValue = (target, key) =>
  (() => {
    const descriptor = Object.getOwnPropertyDescriptor(target || {}, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  })();

export const getStoredEventSchema = (event) => {
  const domainEvent = getStoredDomainEvent(event);
  return isNonEmptyString(domainEvent?.payload?.schema)
    ? domainEvent.payload.schema
    : isNonEmptyString(ownValue(event, "type"))
      ? ownValue(event, "type")
      : undefined;
};

export const getStoredEventData = (event) => {
  const domainEvent = getStoredDomainEvent(event);
  if ("data" in (domainEvent.payload || {})) {
    return isObject(domainEvent.payload.data)
      ? structuredClone(domainEvent.payload.data)
      : domainEvent.payload.data;
  }
  const payload = ownValue(event, "payload");
  return isObject(payload) ? structuredClone(payload) : {};
};

export const getStoredSchemaVersion = (event, fallback = 1) => {
  const domainEvent = getStoredDomainEvent(event);
  return (
    toPositiveIntegerOrNull(domainEvent?.payload?.schemaVersion) ??
    toPositiveIntegerOrNull(ownValue(event, "schemaVersion")) ??
    fallback
  );
};

const defineAlias = (target, key, getter) => {
  if (Object.prototype.hasOwnProperty.call(target, key)) return target;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    get: getter,
  });
  return target;
};

const defineHiddenValue = (target, key, value) => {
  if (!isNonEmptyString(value)) return target;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value,
  });
  return target;
};

export const setStoredContext = (target, { projectId, partition } = {}) => {
  defineHiddenValue(target, "__storedProjectId", projectId);
  defineHiddenValue(target, "__storedPartition", partition);
  return target;
};

const inferStoredPartition = (event) => {
  if (isNonEmptyString(event?.__storedPartition)) return event.__storedPartition;
  const partitions = Array.isArray(event?.partitions) ? event.partitions : [];
  const projectIds = new Set(extractProjectScopeIds(partitions));
  if (isNonEmptyString(event?.__storedProjectId)) {
    projectIds.add(event.__storedProjectId);
  }
  const scopedPartition = partitions.find((partition) => {
    if (!isNonEmptyString(partition)) return false;
    if (projectIds.has(partition)) return false;
    for (const projectId of projectIds) {
      if (partition === buildProjectScopePartition(projectId)) return false;
    }
    return true;
  });
  if (isNonEmptyString(scopedPartition)) return scopedPartition;
  return partitions[0];
};

export const withStoredDraftAliases = (draft) => {
  defineAlias(draft, "client_id", () => draft.clientId);
  defineAlias(draft, "created_at", () => draft.createdAt);
  defineAlias(draft, "projectId", () => draft.__storedProjectId);
  defineAlias(draft, "partition", () => inferStoredPartition(draft));
  defineAlias(draft, "type", () => getStoredEventSchema(draft));
  defineAlias(draft, "schemaVersion", () => getStoredSchemaVersion(draft));
  defineAlias(draft, "payload", () => getStoredEventData(draft));
  defineAlias(draft, "meta", () => ({
    clientId: draft.clientId,
    clientTs: draft.createdAt,
  }));
  defineAlias(draft, "clientTs", () => draft.createdAt);
  return draft;
};

export const withStoredCommittedAliases = (event) => {
  defineAlias(event, "committedId", () => event.committed_id);
  defineAlias(event, "clientId", () => event.client_id);
  defineAlias(event, "serverTs", () => event.status_updated_at);
  defineAlias(event, "createdAt", () => event.status_updated_at);
  defineAlias(event, "projectId", () => event.__storedProjectId);
  defineAlias(event, "partition", () => inferStoredPartition(event));
  defineAlias(event, "type", () => getStoredEventSchema(event));
  defineAlias(event, "schemaVersion", () => getStoredSchemaVersion(event));
  defineAlias(event, "payload", () => getStoredEventData(event));
  defineAlias(event, "meta", () => ({
    clientId: event.client_id,
    clientTs: event.status_updated_at,
  }));
  defineAlias(event, "clientTs", () => event.status_updated_at);
  return event;
};

export const toStoredDraft = (
  input,
  {
    defaultId,
    defaultClientId,
    defaultProjectId,
    defaultClientTs,
    defaultCreatedAt,
  } = {},
) => {
  const meta = normalizeMeta(input?.meta, {
    defaultClientId,
    defaultClientTs,
  });
  const clientId = getStoredClientId(input, meta.clientId ?? defaultClientId);
  const createdAt =
    toFiniteNumberOrNull(input?.createdAt) ??
    toFiniteNumberOrNull(input?.created_at) ??
    toFiniteNumberOrNull(input?.clientTs) ??
    toFiniteNumberOrNull(meta.clientTs) ??
    defaultCreatedAt;
  const partitions = normalizePartitionSet([
    ...(Array.isArray(input?.partitions) ? input.partitions : []),
    input?.projectId ?? input?.__storedProjectId ?? defaultProjectId,
    input?.partition ?? input?.__storedPartition,
  ]);

  const draft = {
    id: isNonEmptyString(input?.id) ? input.id : defaultId,
    clientId,
    partitions,
    event: getStoredDomainEvent(input),
    createdAt,
  };
  setStoredContext(draft, {
    projectId: input?.projectId ?? input?.__storedProjectId ?? defaultProjectId,
    partition: input?.partition ?? input?.__storedPartition,
  });
  return withStoredDraftAliases(draft);
};

export const toStoredCommitted = (
  input,
  {
    defaultClientId,
    defaultProjectId,
    defaultCommittedId,
    defaultStatusUpdatedAt,
  } = {},
) => {
  const draft = toStoredDraft(input, {
    defaultClientId,
    defaultProjectId,
    defaultCreatedAt: defaultStatusUpdatedAt,
  });
  const committed = {
    committed_id: getStoredCommittedId(input) || defaultCommittedId,
    id: draft.id,
    client_id: draft.clientId,
    partitions: draft.partitions,
    event: draft.event,
    status_updated_at: getStoredStatusUpdatedAt(input) || defaultStatusUpdatedAt,
  };
  setStoredContext(committed, {
    projectId: input?.projectId ?? input?.__storedProjectId ?? defaultProjectId,
    partition: input?.partition ?? input?.__storedPartition,
  });
  return withStoredCommittedAliases(committed);
};

export const buildStoredCommittedFromDraft = ({ draft, result }) => {
  const committedId = result.committed_id ?? result.committedId;
  const statusUpdatedAt = result.status_updated_at ?? result.serverTs;
  return toStoredCommitted(
    {
      ...draft,
      projectId: draft.projectId,
      partition: draft.partition,
      committed_id: committedId,
      status_updated_at: statusUpdatedAt,
    },
    {
      defaultClientId: draft.clientId,
      defaultCommittedId: committedId,
      defaultStatusUpdatedAt: statusUpdatedAt,
    },
  );
};

const getComparisonPartitions = (event) => {
  const partitions = getStoredPartitions(event);
  const scopedProjectIds = extractProjectScopeIds(partitions);
  if (scopedProjectIds.length === 0) return partitions;

  return normalizePartitionSet(
    partitions.filter((partition) => {
      const projectId = scopedProjectIds.find(
        (scopeId) => partition === buildProjectScopePartition(scopeId),
      );
      return !(projectId && partitions.includes(projectId));
    }),
  );
};

export const toStoredComparisonKey = (event) =>
  canonicalizeSubmitItem({
    partitions: getComparisonPartitions(event),
    event: getStoredDomainEvent(event),
  });

export const toReducerEvent = (event) => {
  const partitions = getStoredPartitions(event);
  const domainEvent = isObject(event?.event)
    ? getStoredDomainEvent(event)
    : isNonEmptyString(event?.type) && isObject(event?.payload)
      ? { type: event.type, payload: structuredClone(event.payload) }
      : getStoredDomainEvent(event);
  return {
    ...event,
    committedId: getStoredCommittedId(event),
    serverTs: getStoredStatusUpdatedAt(event),
    partition: isNonEmptyString(event?.partition)
      ? event.partition
      : partitions[0],
    partitions,
    type: getStoredEventSchema(event),
    schemaVersion: getStoredSchemaVersion(event),
    payload: getStoredEventData(event),
    event: domainEvent,
  };
};
