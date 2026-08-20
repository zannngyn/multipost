import type { TenantId } from "@/core/domain/tenant-context";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * Member management persistence (M2.3). Types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - the LADDER (core/domain/member-policy) and the LAST_OWNER count run INSIDE
 *   the same transaction that writes, against a row locked FOR UPDATE — two
 *   admins cannot interleave their way past either rule;
 * - every accepted change bumps `membership.version` (cross-process cache
 *   invalidation) and keeps the `app_user` role in step (the M1.1 invariant);
 * - a removal is `status='removed'`, never a delete — the row revives through
 *   an invite (M2.2) — and drops the member's server-side drafts (doc 10 §8.8);
 * - an id this tenant does not hold surfaces as MEMBER_NOT_FOUND; the ladder
 *   as FORBIDDEN; the zero-owner outcome as LAST_OWNER.
 */

export interface MemberListItem {
  readonly membershipId: string;
  readonly accountId: string;
  readonly displayName: string | null;
  /** `identity.email` — the ATTRIBUTE address; the session key stays private. */
  readonly email: string | null;
  readonly role: OperatorRole;
  readonly joinedAt: Date;
}

export interface ChangeMemberRoleRecord {
  readonly tenantId: TenantId;
  readonly membershipId: string;
  readonly newRole: OperatorRole;
  readonly actorRole: OperatorRole;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface RemoveMemberRecord {
  readonly tenantId: TenantId;
  readonly membershipId: string;
  readonly actorRole: OperatorRole;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface MemberChangeResult {
  readonly membershipId: string;
  readonly accountId: string;
  readonly role: OperatorRole;
  readonly version: number;
}

export interface MemberRepo {
  /** ACTIVE memberships only, oldest first (the founding order reads well). */
  listMembers(tenantId: TenantId): Promise<readonly MemberListItem[]>;
  changeRole(input: ChangeMemberRoleRecord): Promise<MemberChangeResult>;
  removeMember(input: RemoveMemberRecord): Promise<MemberChangeResult>;
}
