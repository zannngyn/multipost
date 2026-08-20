import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * Walking-skeleton endpoint: UI -> here -> composition -> usecase -> Drizzle
 * -> Postgres. Thin by contract (docs/07 §3.3): delegate, map errors.
 * No business branching lives in this file.
 *
 * Auth (M1.3b, doc 10 §4.1 + Q8.7): viewer, tier R, tenant from the session.
 * That is what ends its second life as a TENANT ORACLE: until M1.3b anyone
 * signed in could type a UUID and learn from the 404-vs-400 whether that tenant
 * existed. There is no tenant parameter to type any more.
 */

const ROUTE = "GET /api/tenants/health";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no membership, no answer (doc 10 §3) --------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    // The usecase owns the remaining rules (existence, DB errors).
    const result = await container.usecases.healthcheckTenant({ tenantId: ctx.tenantId });
    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
