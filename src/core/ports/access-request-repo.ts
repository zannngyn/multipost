import type { AccessRequest, OperatorIdentity } from "@/core/domain/access-request";
import type { AccessStatus, OperatorProvider, OperatorRole } from "@/shared/operator-access";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Persistence contract of the access registry (E1.4). Types only (docs/07 §2).
 *
 * Contract every implementer must honour:
 * - tenant-scoped (business rule 7) — the caller always names the tenant;
 * - `(tenant_id, provider, provider_account_id)` is THE identity key; a row is
 *   never matched by e-mail alone (that is the account-linking hijack);
 * - `createPending` is idempotent: a second first-sign-in of the same identity
 *   returns the existing row instead of raising a duplicate key. Two browser
 *   tabs hitting the callback at once is a normal race, not an error;
 * - `decide` is atomic: registry row + `app_user` + `audit_log` in ONE
 *   transaction. An approval that is not auditable must not happen at all;
 * - driver failures surface as AppError (DB_ERROR / INVALID_INPUT).
 */

export interface CreatePendingAccessRequestInput {
  readonly tenantId: TenantId;
  readonly identity: OperatorIdentity;
  readonly requestedAt: Date;
}

export interface DecideAccessRequestRecord {
  readonly tenantId: TenantId;
  readonly id: string;
  /** Only a terminal decision is written; a row is never moved back to pending. */
  readonly status: Extract<AccessStatus, "approved" | "blocked">;
  /** Required for `approved`; a block clears the stored role. */
  readonly role: OperatorRole | null;
  readonly decidedAt: Date;
  /** `app_user.id` of the admin, when it could be resolved. */
  readonly decidedByUserId: string | null;
  readonly decidedByEmail: string | null;
}

export interface AccessRequestRepo {
  /** Null when this tenant has never seen that provider identity. */
  findByProviderAccount(
    tenantId: TenantId,
    provider: OperatorProvider,
    providerAccountId: string,
  ): Promise<AccessRequest | null>;

  /** Null when no identity in this tenant signs in under that address. */
  findBySessionEmail(tenantId: TenantId, sessionEmail: string): Promise<AccessRequest | null>;

  /** Returns the freshly created row, or the existing one (idempotent). */
  createPending(input: CreatePendingAccessRequestInput): Promise<AccessRequest>;

  /** `status: "all"` returns every row, newest request first. */
  list(tenantId: TenantId, status: AccessStatus | "all"): Promise<readonly AccessRequest[]>;

  /** Null when this tenant has no request with that id. */
  decide(input: DecideAccessRequestRecord): Promise<AccessRequest | null>;
}
