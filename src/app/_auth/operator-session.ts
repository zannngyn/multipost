import type { OperatorRole } from "@/shared/operator-access";

/**
 * What the app layer needs to know about the signed-in operator.
 * Deliberately smaller than the Auth.js `Session`: screens must not start
 * depending on provider-specific fields.
 */
export interface OperatorSession {
  email: string;
  name: string | null;
  /** True only for the guarded local-dev bypass — never in production. */
  isDevFake: boolean;
  /**
   * Role from the access registry. Null for the dev bypass and for env
   * bootstrap admins: their power comes from env, not from a row, and
   * `isBootstrapAdmin` (not this field) is what opens the admin screens.
   */
  role: OperatorRole | null;
  /**
   * Named INDIVIDUALLY in AUTH_BOOTSTRAP_ADMINS (exact address) or
   * AUTH_FACEBOOK_ALLOWED_USER_IDS (exact id). Matching AUTH_ALLOWED_DOMAINS
   * does NOT set this: a domain covers an open-ended set of people, so it may
   * filter who can sign in but must never hand out unblockable admin rights.
   */
  isBootstrapAdmin: boolean;
}

/** May this operator approve/block other people? */
export function canManageAccess(session: OperatorSession | null): boolean {
  if (!session) return false;
  if (session.isBootstrapAdmin) return true;
  return session.role === "owner" || session.role === "admin";
}
