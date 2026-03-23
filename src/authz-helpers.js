import { extractScopeId } from "./partition-scope.js";

export const authorizeProjectId = ({
  identity,
  projectId,
  allowAll = false,
  claimsField = "projectIds",
}) => {
  if (!identity?.claims) return false;
  if (typeof projectId !== "string" || projectId.length === 0) return false;
  if (allowAll) return true;
  const allowed = identity.claims?.[claimsField];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(projectId);
};

/**
 * @param {{
 *   identity: { claims?: Record<string, unknown> } | null | undefined,
 *   partition: string,
 *   scope?: string,
 *   allowAll?: boolean,
 *   claimsField?: string,
 * }} input
 */
export const authorizeSingleScopeId = ({
  identity,
  partition,
  scope = "project",
  allowAll = false,
  claimsField,
}) => {
  if (!identity?.claims) return false;
  if (typeof partition !== "string" || partition.length === 0) return false;
  const scopeId = extractScopeId(partition, scope);
  if (!scopeId) return false;
  if (allowAll) return true;

  const resolvedClaimsField =
    typeof claimsField === "string" && claimsField.length > 0
      ? claimsField
      : `${scope}Ids`;
  const allowed = identity.claims?.[resolvedClaimsField];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(scopeId);
};
