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
  findUserIdByEmail(tenantId: string, email: string): Promise<string | null>;
}
