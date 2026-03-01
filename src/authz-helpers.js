import { extractScopeIds } from "./partition-scope.js";

/**
 * @param {{
 *   identity: { claims?: Record<string, unknown> } | null | undefined,
 *   partitions: string[],
 *   scope?: string,
 *   allowAll?: boolean,
 *   claimsField?: string,
 * }} input
 */
export const authorizeSingleScopeId = ({
  identity,
  partitions,
  scope = "project",
  allowAll = false,
  claimsField,
}) => {
  if (!identity?.claims) return false;
  if (!Array.isArray(partitions) || partitions.length === 0) return false;

  const scopeIds = extractScopeIds(partitions, scope);
  if (scopeIds.length !== 1) return false;
  if (allowAll) return true;

  const resolvedClaimsField =
    typeof claimsField === "string" && claimsField.length > 0
      ? claimsField
      : `${scope}Ids`;
  const allowed = identity.claims?.[resolvedClaimsField];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(scopeIds[0]);
};
