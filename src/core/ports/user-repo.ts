import type { TenantId } from "@/core/domain/tenant-context";
/**
 * Operator lookup (E11.1 audit trail). Pure TypeScript: types only (docs/07 §2).
 *
 * Why it exists: a session carries an EMAIL, `audit_log.actor_user_id` stores a
 * uuid. Without this translation every operator action is recorded as "system",
 * and "ai bấm chạy lại bài này?" has no answer.
 *
 * Contract for every implementer:
 * - tenant-scoped (business rule 7): the same e-mail may operate two tenants;
 * - e-mail comparison is case-insensitive (app_user.email is stored lower-cased,
 *   a session may not be);
 * - an unknown e-mail returns null — it is NOT an error, the action still
 *   happens and is simply attributed to nobody;
 * - a malformed uuid/driver failure surfaces as AppError (INVALID_INPUT/DB_ERROR).
 */

export interface UserRepo {
  /** Null when this tenant has no user with that e-mail. */
  findUserIdByEmail(tenantId: TenantId, email: string): Promise<string | null>;

  /**
   * The same row, addressed by the ACCOUNT instead of the e-mail (M1.1 gave
   * `app_user` an `account_id` with `UNIQUE (tenant_id, account_id)`).
   *
   * Why a second lookup rather than a replacement: e-mail is an ATTRIBUTE
   * (docs/09 §3.1), so it is the wrong key for anything a person OWNS — change
   * the address on the identity and the drafts would belong to nobody. It is
   * still the right key for the audit trail, where the caller may hold nothing
   * but an address (the env bootstrap door, a job replaying an old payload).
   *
   * Contract: the caller must ALREADY have authorised (account, tenant) —
   * `requireTenant` does — so this performs no membership check of its own and
   * must not be mistaken for one. Null when the account has no `app_user` row
   * in this tenant, which includes a row the M1.1 backfill left `account_id`
   * NULL: not an error, the caller degrades.
   */
  findUserIdByAccount(tenantId: TenantId, accountId: string): Promise<string | null>;
}
