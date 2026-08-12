import { auth } from "./auth";
import { getDevFakeSession } from "./dev-session";
import type { OperatorSession } from "./operator-session";

/**
 * The one way Server Components / Server Actions read the current operator.
 * Screens never touch `auth()` directly, so the dev bypass has exactly one
 * entry point and stays impossible to forget.
 */
export async function getOperatorSession(surface: string): Promise<OperatorSession | null> {
  // Checked first so the bypass needs no auth env at all (see dev-session.ts).
  const fake = getDevFakeSession(surface);
  if (fake) return fake;

  const session = await auth();
  const email = session?.user?.email;

  // Guard: a session without an e-mail is unusable for a tenant-scoped app.
  if (typeof email !== "string" || email.trim().length === 0) return null;

  return { email, name: session?.user?.name ?? null, isDevFake: false };
}
