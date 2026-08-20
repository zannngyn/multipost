import { getOperatorSession } from "@/app/_auth/session";
import type { OperatorSession } from "@/app/_auth/operator-session";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { ACCESS_REGISTRY_TENANT_ID, type TenantId } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import type { AuthzTier } from "@/composition/require-tenant";

/**
 * Who may read and decide access requests (M1.3b edition).
 *
 * Two doors, deliberately:
 *   1. ENV BOOTSTRAP ADMINS — the escape hatch. They may hold no account row
 *      at all (their grant lives in env, not in the database), so
 *      `requireTenant` would answer 401 for exactly the people this screen
 *      exists to serve when the registry is empty/broken. They keep the legacy
 *      path: authority from `isBootstrapAdmin`, tenant fixed to the registry
 *      tenant (today's demo tenant — where every `access_request` row lives).
 *      This door retires with the whole screen at M2.4.
 *   2. EVERYONE ELSE — `requireTenantContext` with minRole admin: the acting
 *      tenant comes from their membership, checked at the caller's tier. With
 *      today's data that IS the demo tenant, so semantics are unchanged.
 *
 * The route then operates on the returned `tenantId` — never on one from the
 * query string or body (those are ignored as of M1.3b).
 */
export async function requireAccessAdmin(
  request: Request,
  options: { readonly route: string; readonly tier: AuthzTier },
): Promise<{ session: OperatorSession; tenantId: TenantId }> {
  const surface = `api:${options.route}`;

  const session = await getOperatorSession(surface);
  if (!session) {
    throw new AppError("UNAUTHORIZED", {
      message: "Access administration requires a signed-in operator",
      context: { route: options.route, reason: "NO_SESSION" },
    });
  }

  // Door 1 — the env escape hatch (see the header). Checked FIRST so a broken
  // account table can never lock the repair crew out of the repair screen.
  if (session.isBootstrapAdmin) {
    return { session, tenantId: ACCESS_REGISTRY_TENANT_ID };
  }

  // Door 2 — membership-based, role admin+ (doc 10 §4.4).
  const { ctx } = await requireTenantContext(request, {
    surface,
    tier: options.tier,
    minRole: "admin",
  });
  return { session, tenantId: ctx.tenantId };
}
