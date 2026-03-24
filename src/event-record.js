export const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

export const toFiniteNumberOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

export const toPositiveIntegerOrNull = (value) =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

export const cloneObject = (value, fallback = {}) =>
  isObject(value) ? structuredClone(value) : fallback;

export const normalizeMeta = (
  meta,
  { defaultClientId, defaultClientTs } = {},
) => {
  const normalized = cloneObject(meta, {});

  if (!isNonEmptyString(normalized.clientId)) {
    if (isNonEmptyString(defaultClientId)) {
      normalized.clientId = defaultClientId;
    } else {
      delete normalized.clientId;
    }
  }

  const clientTs =
    toFiniteNumberOrNull(normalized.clientTs) ??
    toFiniteNumberOrNull(defaultClientTs);
  if (clientTs === null) {
    delete normalized.clientTs;
  } else {
    normalized.clientTs = clientTs;
  }

  return normalized;
};

export const normalizeClientTs = (value, { defaultClientTs } = {}) => {
  return (
    toFiniteNumberOrNull(value) ?? toFiniteNumberOrNull(defaultClientTs) ?? undefined
  );
};

export const normalizeSubmitEventInput = (
  input,
  {
    defaultId,
    defaultProjectId,
    defaultClientId,
    defaultClientTs,
  } = {},
) => {
  const domainEvent = isObject(input?.event) ? input.event : undefined;
  const payload = isObject(input?.payload)
    ? input.payload
    : isObject(domainEvent?.payload)
      ? domainEvent.payload
      : undefined;
  const type = isNonEmptyString(input?.type)
    ? input.type
    : isNonEmptyString(domainEvent?.type)
      ? domainEvent.type
      : undefined;
  const schemaVersion =
    toPositiveIntegerOrNull(input?.schemaVersion) ??
    toPositiveIntegerOrNull(domainEvent?.schemaVersion) ??
    undefined;

  return {
    id: isNonEmptyString(input?.id)
      ? input.id
      : isNonEmptyString(defaultId)
        ? defaultId
        : undefined,
    partition: isNonEmptyString(input?.partition) ? input.partition : undefined,
    projectId: isNonEmptyString(input?.projectId)
      ? input.projectId
      : isNonEmptyString(defaultProjectId)
        ? defaultProjectId
        : undefined,
    userId: isNonEmptyString(input?.userId) ? input.userId : undefined,
    type,
    schemaVersion,
    payload: payload === undefined ? undefined : structuredClone(payload),
    clientTs: normalizeClientTs(input?.clientTs, {
      defaultClientTs:
        normalizeClientTs(input?.meta?.clientTs) ?? defaultClientTs,
    }),
    meta: normalizeMeta(input?.meta, {
      defaultClientId,
      defaultClientTs,
    }),
  };
};

export const buildCommittedEventFromDraft = ({
  draft,
  committedId,
  serverTs,
}) => ({
  committedId,
  id: draft.id,
  projectId: draft.projectId,
  userId: draft.userId,
  partition: draft.partition,
  type: draft.type,
  schemaVersion: draft.schemaVersion,
  payload: structuredClone(draft.payload),
  payloadCompression: draft.payloadCompression,
  clientTs: normalizeClientTs(draft.clientTs, {
    defaultClientTs: draft.meta?.clientTs,
  }),
  serverTs,
});
