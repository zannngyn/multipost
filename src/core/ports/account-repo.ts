import type { AccountStatus, MembershipStatus, PlatformRole } from "@/core/domain/account";
import type { TenantStatus } from "@/core/domain/tenant";
import type { OperatorProvider, OperatorRole } from "@/shared/operator-access";

/**
 * Global identity persistence (M1.2, docs/09 §3.1–3.3). Types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - `session_email` comparison is case-insensitive; the column stores lower-case
 *   by contract and callers may hand over whatever the JWT carried;
 * - `findAccountBySessionEmail` is THE per-request lookup: identity → account →
 *   active memberships, one round trip. A lookup that can return two accounts
 *   for one address must be impossible (the schema's global unique holds that);
 * - `attachProviderAccountId` PATCHES the existing identity row in an UPDATE —
 *   never inserts. The M1.1 backfill minted `legacy-app-user:*` placeholders,
 *   and an insert keyed on (provider, sub) would collide with
 *   `identity_session_email_uq` the moment the real sub arrives;
 * - tenant ids stay `string` here until M1.3a brands the whole port layer;
 * - driver failures surface as AppError (DB_ERROR / INVALID_INPUT).
 */

export interface OperatorIdentityRecord {
  readonly provider: OperatorProvider;
  readonly providerAccountId: string;
  readonly sessionEmail: string;
  readonly email: string | null;
}

/** One active membership as the session/gate needs it — no tenant join. */
export interface AccountMembership {
  readonly tenantId: string;
  readonly role: OperatorRole;
  readonly version: number;
}

export interface OperatorAccountSummary {
  readonly accountId: string;
  readonly status: AccountStatus;
  readonly platformRole: PlatformRole | null;
  readonly displayName: string | null;
  readonly identity: OperatorIdentityRecord;
  /** ACTIVE memberships only — `removed` rows are authorisation history. */
  readonly activeMemberships: readonly AccountMembership[];
}

/** Membership + the tenant columns every authorisation decision needs. */
export interface MembershipWithTenant {
  readonly tenantId: string;
  readonly role: OperatorRole;
  readonly status: MembershipStatus;
  readonly version: number;
  readonly tenantStatus: TenantStatus;
  readonly tenantName: string;
  readonly tenantSlug: string | null;
  readonly tenantPlan: string;
}

export interface AttachProviderAccountIdInput {
  readonly provider: OperatorProvider;
  readonly sessionEmail: string;
  /** The REAL sub/app-scoped id the provider just confirmed. */
  readonly providerAccountId: string;
}

export interface AccountRepo {
  /** Null when no identity signs in under that address. */
  findAccountBySessionEmail(sessionEmail: string): Promise<OperatorAccountSummary | null>;

  /**
   * Replace a placeholder/stale `provider_account_id` with the real one, keyed
   * by (provider, session_email). Returns false when no row matched — which the
   * caller logs, because a patch that silently went nowhere is a future
   * unique-constraint explosion. Never touches a row of another provider.
   */
  attachProviderAccountId(input: AttachProviderAccountIdInput): Promise<boolean>;

  /** Fresh read (tier S). Null when the pair has no membership row at all. */
  findMembership(accountId: string, tenantId: string): Promise<MembershipWithTenant | null>;

  /**
   * Cheap fresh read for tier M: just the version (null = no row). Comparing it
   * against a cached row detects a revoke/role change across processes.
   */
  findMembershipVersion(accountId: string, tenantId: string): Promise<number | null>;

  /** ACTIVE memberships joined with tenant name/slug/plan, for /api/me. */
  listMembershipsWithTenant(accountId: string): Promise<readonly MembershipWithTenant[]>;
}
