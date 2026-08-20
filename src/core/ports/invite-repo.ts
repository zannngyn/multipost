import type { TenantId } from "@/core/domain/tenant-context";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * Invite persistence (M2.2, docs/09 §3.6). Types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - the port speaks TOKEN HASHES; the raw token exists only in the response
 *   that created it (same discipline as `oauth_state`);
 * - `claim` is ATOMIC per invite row: the row is locked for the length of the
 *   decision, so a single-use invite claimed by two racing browsers admits
 *   exactly one;
 * - an existing ACTIVE membership is a no-op that burns NO use;
 * - a `removed` membership is REVIVED on the same row (status active, role
 *   from the invite, version bump) — never a second row (docs/09 §3.6);
 * - membership + `app_user` + `used_count` + audit are one transaction.
 */

export interface InviteListItem {
  readonly id: string;
  readonly role: OperatorRole;
  readonly expiresAt: Date;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly revokedAt: Date | null;
  /** Session address of the creator's identity; null when unresolvable. */
  readonly createdByEmail: string | null;
}

export interface CreateInviteRecord {
  readonly tenantId: TenantId;
  readonly role: OperatorRole;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly maxUses: number;
  readonly createdByAccountId: string;
  readonly actorEmail: string | null;
}

export interface RevokeInviteRecord {
  readonly tenantId: TenantId;
  readonly id: string;
  readonly revokedAt: Date;
  readonly actorAccountId: string | null;
  readonly actorEmail: string | null;
}

export interface ClaimInviteRecord {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly sessionEmail: string;
  readonly displayName: string | null;
  readonly now: Date;
}

export interface JoinedTenantSummary {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string | null;
  readonly plan: string;
}

export type ClaimInviteResult =
  /** One kind for every refusal; `reason` goes to the LOG, never to the caller. */
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly kind: "already_member";
      readonly tenant: JoinedTenantSummary;
      readonly role: OperatorRole;
    }
  | { readonly kind: "joined"; readonly tenant: JoinedTenantSummary; readonly role: OperatorRole };

export interface InviteRepo {
  /** Newest first. */
  listInvites(tenantId: TenantId): Promise<readonly InviteListItem[]>;
  createInvite(input: CreateInviteRecord): Promise<{ id: string }>;
  /** Idempotent: revoking a revoked invite reports it without a second audit. */
  revokeInvite(input: RevokeInviteRecord): Promise<"revoked" | "already_revoked" | "not_found">;
  claimInvite(input: ClaimInviteRecord): Promise<ClaimInviteResult>;
}
