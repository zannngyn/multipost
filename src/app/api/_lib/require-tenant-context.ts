import { getOperatorSession } from "@/app/_auth/session";
import { readActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import type { AuthzTier, TenantContext } from "@/composition/require-tenant";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — THE one way a tenant-scoped route learns its tenant (doc 10 §2–3).
 *
 * One call replaces the old `tenantId` query/body field: it resolves the
 * session, reads the active-tenant SELECTOR cookie, and asks `requireTenant()`
 * to authorise against the membership row in the database. Routes never accept
 * a tenant id from the client again — a `tenantId` the client still sends is
 * stripped by the zod schema and ignored (transition rule, docs/11 §3.2;
 * M1.4 removes it from the UI).
 *
 * Every route states its CLAIM here, from the doc 10 §4 matrix:
 *   - `tier`:   "S" fresh read | "M" cache + version check | "R" cached ≤60s
 *   - `minRole`: the minimum tenant role, omitted = any member
 *
 * Refusals (thrown as AppError, mapped by mapAppErrorToHttp):
 *   401 UNAUTHORIZED · 409 TENANT_NOT_SELECTED · 404 TENANT_NOT_FOUND ·
 *   403 FORBIDDEN — semantics in doc 10 §3.
 */
export async function requireTenantContext(
  request: Request,
  options: {
    /** For session log lines, e.g. `api:GET /api/catalog/products`. */
    readonly surface: string;
    readonly tier: AuthzTier;
    readonly minRole?: OperatorRole;
  },
): Promise<{ ctx: TenantContext; session: NonNullable<Awaited<ReturnType<typeof getOperatorSession>>> }> {
  const container = getContainer();

  // --- Edge case first: middleware already guards, but a route must not
  // trust that it was reached through the guard (same stance as every page).
  const session = await getOperatorSession(options.surface);
  if (!session) {
    throw new AppError("UNAUTHORIZED", {
      message: `${options.surface} requires a signed-in operator`,
      context: { route: options.surface },
    });
  }

  const ctx = await container.usecases.requireTenant(session, readActiveTenantCookie(request), {
    tier: options.tier,
    ...(options.minRole ? { minRole: options.minRole } : {}),
  });

  return { ctx, session };
}
