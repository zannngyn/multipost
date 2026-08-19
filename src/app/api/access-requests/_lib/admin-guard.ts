import { getOperatorSession } from "@/app/_auth/session";
import { canManageAccess, type OperatorSession } from "@/app/_auth/operator-session";
import { AppError } from "@/core/domain/errors";

/**
 * Who may read and decide access requests.
 *
 * Middleware only proves "has a session cookie"; deciding who else gets in is
 * an administrative act, so it is gated again here — an approved `viewer` must
 * not be able to approve anybody. `getOperatorSession` has already re-read the
 * status from the registry, so a blocked operator never reaches this function
 * with a usable session.
 *
 * Two distinct refusals on purpose: 401 sends the caller back to /signin, 403
 * does not (the session is fine, the person simply is not an admin).
 */
export async function requireAccessAdmin(route: string): Promise<OperatorSession> {
  const session = await getOperatorSession(`api:${route}`);

  if (!session) {
    throw new AppError("UNAUTHORIZED", {
      message: "Access administration requires a signed-in operator",
      context: { route, reason: "NO_SESSION" },
    });
  }

  if (!canManageAccess(session)) {
    throw new AppError("ACCESS_FORBIDDEN", {
      message: "Operator role may not decide access requests",
      context: { route, actor_email: session.email, actor_role: session.role },
    });
  }

  return session;
}
