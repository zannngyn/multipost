import type { OperatorRole } from "@/shared/operator-access";

/**
 * Account / identity / membership vocabulary (docs/09 §3.1). Pure TypeScript.
 * The pg enums in adapters/db/schema/{account,membership}.ts mirror these —
 * keep both in sync (their comments point back here).
 */

/** Platform-level ban: blocks sign-in everywhere. Per-tenant loss is membership. */
export const ACCOUNT_STATUSES = ["active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Platform roles live in shared/operator-access (the session carries them and
 * the app layer must reach the type). Re-exported here so domain code has one
 * import for the whole account vocabulary.
 */
export { isPlatformRole, PLATFORM_ROLES } from "@/shared/operator-access";
export type { PlatformRole } from "@/shared/operator-access";

/** `removed`, never deleted: audit refers to the row and re-invites reuse it. */
export const MEMBERSHIP_STATUSES = ["active", "removed"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" && (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

/**
 * The one role ladder (doc 10 §1): viewer < editor < admin < owner.
 * Kept as data so `roleAtLeast` cannot drift from the contract's table.
 */
const ROLE_RANK: Record<OperatorRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: OperatorRole, minimum: OperatorRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
