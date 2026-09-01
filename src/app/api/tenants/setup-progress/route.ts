import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * First-run — "còn mấy bước nữa thì đăng được bài?" in ONE request.
 *
 * Thin by contract (docs/07 §3.3): authorise, delegate, map errors. No business
 * branching lives in this file; which step counts as done is the usecase's.
 *
 * The dock that reads this rides in the app shell, so it would otherwise cost
 * five requests on every screen. One endpoint, one query, `staleTime` on the
 * client side.
 *
 * `minRole: "admin"` (doc 10 §4): every step behind this list is an admin
 * action — connect Google, choose a sheet, connect a Fanpage, make a group. An
 * editor asking would receive a list of things they cannot do, so they are not
 * shown the dock and the route refuses them too.
 */

const ROUTE = "GET /api/tenants/setup-progress";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "admin",
    });

    const progress = await container.usecases.getSetupProgress({ tenantId: ctx.tenantId });
    return Response.json(progress);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
