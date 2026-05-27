const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

/**
 * @param {string} partition
 * @returns {{ scope: string, scopeId: string, remainder: string[] } | null}
 */
export const parsePartitionScope = (partition) => {
  if (!isNonEmptyString(partition)) return null;
  const segments = partition.split(":");
  if (segments.length < 2) return null;
  const [scope, scopeId, ...remainder] = segments;
  if (!isNonEmptyString(scope) || !isNonEmptyString(scopeId)) return null;
  return { scope, scopeId, remainder };
};

/**
 * @param {string} partition
 * @param {string} scope
 * @returns {string|null}
 */
export const extractScopeId = (partition, scope) => {
  const parsed = parsePartitionScope(partition);
  if (!parsed) return null;
  if (parsed.scope !== scope) return null;
  return parsed.scopeId;
};

/**
 * @param {string[]} partitions
 * @param {string} scope
 * @returns {string[]}
 */
export const extractScopeIds = (partitions, scope) => {
  if (!Array.isArray(partitions) || !isNonEmptyString(scope)) return [];
  const ids = new Set();
  for (const partition of partitions) {
    const scopeId = extractScopeId(partition, scope);
    if (scopeId) ids.add(scopeId);
  }
  return [...ids];
};

const createScopeError = (code, message, details = {}) => {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
};

/**
 * @param {{ partitions: string[], scope: string }} input
 * @returns {string}
 */
export const requireSingleScopeId = ({ partitions, scope }) => {
  const ids = extractScopeIds(partitions, scope);
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw createScopeError(
      "validation_failed",
      `No '${scope}' scope found in partitions`,
      { scope, partitions },
    );
  }
  throw createScopeError(
    "validation_failed",
    `Multiple '${scope}' scope ids are not allowed`,
    { scope, ids, partitions },
  );
};

/**
 * @param {{ scope: string, scopeId: string, path?: string[] }} input
 * @returns {string}
 */
export const buildScopePartition = ({ scope, scopeId, path = [] }) => {
  if (!isNonEmptyString(scope)) {
    throw new Error("buildScopePartition: scope is required");
  }
  if (!isNonEmptyString(scopeId)) {
    throw new Error("buildScopePartition: scopeId is required");
  }
  const suffix = Array.isArray(path)
    ? path.filter((segment) => isNonEmptyString(segment))
    : [];
  return [scope, scopeId, ...suffix].join(":");
};

export const PROJECT_SCOPE = "project";

/**
 * @param {string} projectId
 * @returns {string}
 */
export const buildProjectScopePartition = (projectId) =>
  buildScopePartition({ scope: PROJECT_SCOPE, scopeId: projectId });

/**
 * @param {string[]} partitions
 * @returns {string[]}
 */
export const extractProjectScopeIds = (partitions) =>
  extractScopeIds(partitions, PROJECT_SCOPE);

/**
 * The raw project id is retained for old SQLite rows. The scoped partition is
 * authoritative for newly written rows because raw partition names can collide
 * with another project's id.
 *
 * @param {string} projectId
 * @returns {string[]}
 */
export const getProjectPartitions = (projectId) => {
  if (!isNonEmptyString(projectId)) return [];
  return [projectId, buildProjectScopePartition(projectId)];
};

/**
 * @param {string[]} partitions
 * @param {string} projectId
 * @returns {boolean}
 */
export const partitionSetBelongsToProject = (partitions, projectId) => {
  if (!Array.isArray(partitions) || !isNonEmptyString(projectId)) return false;
  const scopedProjectIds = extractProjectScopeIds(partitions);
  if (scopedProjectIds.length > 0) {
    return scopedProjectIds.length === 1 && scopedProjectIds[0] === projectId;
  }
  return partitions.includes(projectId);
};
