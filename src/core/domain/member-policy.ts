import { roleAtLeast } from "@/core/domain/account";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * Member-management ladder (M2.3, doc 10 §4.4 as settled after the M0 gate).
 * Pure functions: the repo calls them INSIDE its transaction against the
 * target's freshly-locked role, so two admins cannot ladder past each other.
 *
 * The rules, in one place:
 *   - an ADMIN only touches editor/viewer, and only assigns editor/viewer —
 *     promoting to admin/owner and touching another admin/owner is OWNER work;
 *   - an OWNER does everything, EXCEPT whatever would leave the company with
 *     zero active owners (the LAST_OWNER check — counted in the transaction,
 *     not here, because only the database knows the count);
 *   - removing YOURSELF is leaving the company: allowed regardless of the
 *     ladder (an admin may leave without an owner's help), last-owner rule
 *     still applies upstream.
 */

export type MemberPolicyVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "LADDER" };

const ADMIN_MAY_TOUCH: readonly OperatorRole[] = ["editor", "viewer"];

export function canChangeMemberRole(
  actorRole: OperatorRole,
  targetRole: OperatorRole,
  newRole: OperatorRole,
): MemberPolicyVerdict {
  if (actorRole === "owner") return { allowed: true };
  // Admin: both the CURRENT and the NEW role must sit below admin.
  if (
    actorRole === "admin" &&
    ADMIN_MAY_TOUCH.includes(targetRole) &&
    ADMIN_MAY_TOUCH.includes(newRole)
  ) {
    return { allowed: true };
  }
  return { allowed: false, reason: "LADDER" };
}

export function canRemoveMember(
  actorRole: OperatorRole,
  targetRole: OperatorRole,
  isSelf: boolean,
): MemberPolicyVerdict {
  // Leaving the company is always the member's own right (last-owner aside).
  if (isSelf) return { allowed: true };
  if (actorRole === "owner") return { allowed: true };
  if (actorRole === "admin" && ADMIN_MAY_TOUCH.includes(targetRole)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "LADDER" };
}

/** Sanity export so callers need not re-import roleAtLeast separately. */
export { roleAtLeast };
