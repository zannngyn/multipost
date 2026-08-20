import type { TenantStatus } from "@/core/domain/tenant";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Platform tenant administration (M3.2, docs/09 §3.5 + doc 10 §4.4). Types
 * only. This is the PLATFORM layer: unlike every business port it legitimately
 * receives a target tenant id (already branded by the platform constructor) —
 * a super_admin names which customer they are acting on.
 *
 * Contract for every implementer:
 * - `createTenant` mints NO membership: MYSP staff are not members of a
 *   customer's company; the owner arrives through the invite the caller mints
 *   right after (M2.2 infrastructure);
 * - `setStatus` is idempotent (suspending a suspended tenant reports
 *   `already`), audited with the caller's reason, and never deletes anything;
 * - unknown tenant surfaces as TENANT_NOT_FOUND.
 */

export interface PlatformTenantListItem {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string | null;
  readonly plan: string;
  readonly status: TenantStatus;
  readonly memberCount: number;
  readonly createdAt: Date;
}

export interface PlatformCreateTenantRecord {
  readonly name: string;
  readonly slug: string;
  readonly plan: "internal" | "standard";
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface PlatformCreatedTenant {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
  readonly status: TenantStatus;
}

export interface SetTenantStatusRecord {
  readonly tenantId: TenantId;
  readonly status: TenantStatus;
  /** Mandatory book entry — heavy switches carry their why. */
  readonly reason: string;
  readonly actorAccountId: string;
  readonly actorEmail: string | null;
}

export interface SetTenantStatusResult {
  readonly tenantId: TenantId;
  readonly status: TenantStatus;
  /** True = the tenant was already in that state; nothing changed, no audit. */
  readonly already: boolean;
}

export interface PlatformTenantRepo {
  /** Every tenant, newest first, with the ACTIVE member count. */
  listTenants(): Promise<readonly PlatformTenantListItem[]>;
  /** Throws SLUG_TAKEN on a duplicate slug. */
  createTenant(input: PlatformCreateTenantRecord): Promise<PlatformCreatedTenant>;
  /** Throws TENANT_NOT_FOUND. Idempotent per the result's `already`. */
  setStatus(input: SetTenantStatusRecord): Promise<SetTenantStatusResult>;
}
