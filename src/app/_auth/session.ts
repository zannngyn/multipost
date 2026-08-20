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
 * A suspended account reads as NO SESSION — felt within ACCOUNT_CACHE_TTL_MS
 * (≤60s), immediately in the process that wrote the decision.
 *
 * M2.4 (reverses an M1.2 decision, deliberately): an active account with ZERO
 * memberships is a VALID session — the NoMembership state of docs/09 §3.8.
 * Sign-in provisions strangers instead of queueing them, so this state is now
 * "person in the lobby", not "un-approved registrant". Screens keep working
 * because nothing tenant-scoped renders from the session alone: every page and
 * route goes through requireTenant, which answers 409 TENANT_NOT_SELECTED for
 * a lobby session, and the UI shows the create-or-join screen.
 *
 * ORDER OF PRECEDENCE (M3.1 edition — same wording in auth.config.ts and
 * signin-gate.ts; change one, change all three):
 *   1. DEV_FAKE_SESSION — local dev only;
 *   2. the account tables, short-cached — THE source of truth the moment an
 *      account row exists. This includes bootstrap admins: their env entry is
 *      a SEED (promoted once to `platform_role='super_admin'`, audited) and a
 *      RESCUE (only when no row exists or the DB is unreachable). A bootstrap
 *      admin whose row is suspended is OUT like anyone else — that is N9;
 *   3. the env bootstrap lists of INDIVIDUALS — seed + rescue only, see above.
 *      AUTH_ALLOWED_DOMAINS is NOT one of them: it filters who may sign in and
 *      grants nothing.
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
     * M3.1: once the account ROW exists, the DATABASE decides — the env only
     * SEEDS it. `resolve` never throws; a null answer covers both "no row yet"
     * and "DB unreachable", and only THEN does the env carry the session (the
     * rescue door, deliberately account-less so no platform op can run on it).
     */
    const gate = getContainer().usecases.operatorAccounts;
    const account = await gate.resolve(email);

    if (account) {
      // N9 closed: a suspended bootstrap admin is refused BY THE DATABASE.
      if (account.status !== "active") return null;

      let platformRole = account.platformRole;
      if (platformRole === null) {
        // One-time env→DB promotion (audited, race-safe in the repo). Failure
        // is logged inside and the env keeps carrying them until next time.
        const granted = await gate.grantBootstrapRole(account.accountId, email);
        if (granted) platformRole = "super_admin";
      }

      return {
        email,
        name,
        isDevFake: false,
        role: null,
        isBootstrapAdmin: true,
        accountId: account.accountId,
        platformRole,
      };
    }

    return {
      email,
      name,
      isDevFake: false,
      role: null,
      isBootstrapAdmin: true,
      accountId: null,
      platformRole: null,
    };
  }

  const account = await getContainer().usecases.operatorAccounts.resolve(email);

  // --- Edge cases first: unknown identity, or a platform ban -----------------
  if (!account) return null;
  if (account.status !== "active") return null;

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
