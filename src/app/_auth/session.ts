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
 * IT IS ALSO THE REVOCATION POINT (E1.4). The session is a stateless JWT: a row
 * flipped to `blocked` cannot end it, and a check inside the `signIn` callback
 * only ever ran once, at sign-in. So the access status is re-read HERE, on
 * every request — this function runs in Node (unlike the edge middleware) and
 * can reach the database, and every screen and every route that reads the
 * operator goes through it. A status that is not `approved` reads as NO
 * SESSION, which the layout turns into a redirect to /signin.
 *
 * ORDER OF PRECEDENCE (same as the sign-in gate, see auth.config.ts):
 *   1. DEV_FAKE_SESSION — local dev only;
 *   2. the bootstrap lists of INDIVIDUALS (AUTH_BOOTSTRAP_ADMINS exact
 *      addresses, AUTH_FACEBOOK_ALLOWED_USER_IDS exact ids) — always in, even
 *      with an empty registry, so nobody can lock themselves out of the screen
 *      that grants access. AUTH_ALLOWED_DOMAINS is NOT one of them: it filters
 *      who may sign in and grants nothing, so a colleague on the company domain
 *      is an ordinary operator who can be blocked like anyone else;
 *   3. the `access_request` registry, short-cached (composition/operator-access-gate).
 */
export async function getOperatorSession(surface: string): Promise<OperatorSession | null> {
  // Checked first so the bypass needs no auth env at all (see dev-session.ts).
  const fake = getDevFakeSession(surface);
  if (fake) return fake;

  const session = await auth();
  const email = session?.user?.email;

  // Guard: a session without an e-mail is unusable for a tenant-scoped app.
  if (typeof email !== "string" || email.trim().length === 0) return null;

  const name = session?.user?.name ?? null;

  if (isBootstrapOperatorEmail(email)) {
    return { email, name, isDevFake: false, role: null, isBootstrapAdmin: true };
  }

  const state = await getContainer().usecases.operatorAccess.readState(
    ACCESS_REGISTRY_TENANT_ID,
    email,
  );
  // `pending`, `blocked` and `unknown` all mean the same thing to a caller:
  // there is no usable session. The gate has already logged the reason.
  if (state.status !== "approved") return null;

  return { email, name, isDevFake: false, role: state.role, isBootstrapAdmin: false };
}
