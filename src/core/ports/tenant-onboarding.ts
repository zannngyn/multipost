import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Self-service tenant creation (M2.1, docs/09 §3.7). Types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - the WHOLE act is one transaction: tenant + owner membership + `app_user`
 *   (the M1.1 1:1 invariant) + audit row — a company without an owner must be
 *   impossible, even mid-crash;
 * - the abuse limits are counted INSIDE that transaction, behind a per-account
 *   advisory lock: two concurrent creates must not both pass the count;
 * - refusals are typed: SLUG_TAKEN, TENANT_LIMIT_REACHED (with which limit in
 *   the log context), never a raw unique-violation 503.
 */

export interface CreateTenantRecord {
  readonly accountId: string;
  /** For the `app_user` row and the audit trail. */
  readonly sessionEmail: string;
  readonly displayName: string | null;
  readonly name: string;
  readonly slug: string;
  readonly now: Date;
  /** Abuse limits (docs/09 §3.7), resolved from config by the caller. */
  readonly maxCreatedTotal: number;
  readonly maxCreatedPerHour: number;
}

export interface CreatedTenant {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
}

export interface TenantOnboardingRepo {
  createTenant(input: CreateTenantRecord): Promise<CreatedTenant>;
}
