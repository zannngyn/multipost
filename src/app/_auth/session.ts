import { ACCESS_REGISTRY_TENANT_ID, getContainer } from "@/composition/container";

import { auth } from "./auth";
import { isBootstrapOperatorEmail } from "./auth.config";
import { getDevFakeSession } from "./dev-session";
import type { OperatorSession } from "./operator-session";

/**
 * The one way Server Components / Server Actions read the current operator.
 * Screens never touch `auth()` directly, so the dev bypass has exactly one
 * entry point and stays impossible to forget.
 *
 * IT IS ALSO THE REVOCATION POINT. The session is a stateless JWT: flipping a
 * row cannot end it, and a check inside the `signIn` callback only ever ran
 * once, at sign-in. So the person's standing is re-read HERE, on every request
 * — this function runs in Node (unlike the edge middleware) and can reach the
 * database, and every screen and every route that reads the operator goes
 * through it.
 *
 * SOURCE OF TRUTH (M1.2, docs/09 §3.1/3.3): identity → account → membership.
 * A suspended account, or one with no active membership anywhere, reads as NO
 * SESSION — the layout turns that into a redirect to /signin. Suspension is
 * felt within ACCOUNT_CACHE_TTL_MS (≤60s), immediately in the process that
 * wrote the decision.
 *
 * PENDING(M2-nomembership): "active account, zero memberships" will become a
 * REAL signed-in state (NoMembership → the create-or-join screen) when
 * self-service lands. Until then it must stay null: today the only people in
 * that state are un-approved registrants, and pre-M1.2 behaviour for them is
 * "đang chờ duyệt", not an empty app shell.
 *
 * ORDER OF PRECEDENCE (same as the sign-in gate, see auth.config.ts):
 *   1. DEV_FAKE_SESSION — local dev only;
 *   2. the bootstrap lists of INDIVIDUALS (AUTH_BOOTSTRAP_ADMINS exact
 *      addresses, AUTH_FACEBOOK_ALLOWED_USER_IDS exact ids) — always in, even
 *      with an empty database, so nobody can lock themselves out of the screen
 *      that grants access. AUTH_ALLOWED_DOMAINS is NOT one of them: it filters
 *      who may sign in and grants nothing;
 *   3. the account tables, short-cached (composition/operator-account-gate).
 */
export async function getOperatorSession(surface: string): Promise<OperatorSession | null> {
  // Checked first so the bypass needs no auth env at all (see dev-session.ts).
  const fake = getDevFakeSession(surface);
  if (fake) {
    /**
     * M1.3b: routes authorise through `requireTenant`, which needs an ACCOUNT.
     * The seeded dev@localhost has one — attach it BEST-EFFORT (`resolve`
     * never throws), so the bypass exercises the same authorisation path as a
     * real session. With no database the bypass still opens, only the
     * tenant-scoped routes then answer 401 — which is what they should say.
     */
    try {
      const devAccount = await getContainer().usecases.operatorAccounts.resolve(fake.email);
      return {
        ...fake,
        accountId: devAccount?.accountId ?? null,
        platformRole: devAccount?.platformRole ?? null,
      };
    } catch {
      // `resolve` never throws, but `getContainer()` itself needs DATABASE_URL;
      // the bypass is explicitly for a box with NO env at all, so a failed
      // container build degrades to the account-less session instead of taking
      // the bypass down with it. Nothing is swallowed silently: every
      // tenant-scoped call will refuse loudly with 401.
      return fake;
    }
  }

  const session = await auth();
  const email = session?.user?.email;

  // Guard: a session without an e-mail is unusable for a tenant-scoped app.
  if (typeof email !== "string" || email.trim().length === 0) return null;

  const name = session?.user?.name ?? null;

  if (isBootstrapOperatorEmail(email)) {
    /**
     * The escape hatch stays database-free on the critical path: a bootstrap
     * admin must get in even when the account tables are unreachable. Their
     * account row (if any) is still resolved BEST-EFFORT so /api/me and the
     * future requireTenant see the person — `resolve` never throws.
     */
    const account = await getContainer().usecases.operatorAccounts.resolve(email);
    return {
      email,
      name,
      isDevFake: false,
      role: null,
      isBootstrapAdmin: true,
      accountId: account?.accountId ?? null,
      platformRole: account?.platformRole ?? null,
    };
  }

  const account = await getContainer().usecases.operatorAccounts.resolve(email);

  // --- Edge cases first: no account, banned, or no membership anywhere ------
  if (!account) return null;
  if (account.status !== "active") return null;
  if (account.activeMemberships.length === 0) return null; // PENDING(M2-nomembership)

  /**
   * `role` keeps its pre-M1.2 meaning for the 13 existing consumers: the
   * person's role in the ONE tenant everything currently runs in. Multi-tenant
   * callers must ignore it and go through `requireTenant` — it dies in M1.3.
   */
  const legacyRole =
    account.activeMemberships.find(
      (membership) => membership.tenantId === ACCESS_REGISTRY_TENANT_ID,
    )?.role ?? null;

  return {
    email,
    name: name ?? account.displayName,
    isDevFake: false,
    role: legacyRole,
    isBootstrapAdmin: false,
    accountId: account.accountId,
    platformRole: account.platformRole,
  };
}
