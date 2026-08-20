import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * E2 — "đã kết nối Google chưa?" for the sync screen.
 *
 * Three states, never a token: `not_connected`, `connected` (with the account
 * e-mail, the moment and the granted scopes) and `expired` — a connection whose
 * refresh token Google rejected, which reads differently to a human than "never
 * connected" even though both end at the same button.
 *
 * Auth (M1.3b, doc 10 §4.1): viewer, tier R. The query string carries nothing
 * any more — a `tenantId` an old UI build still appends is simply not read
 * (transition rule, docs/11 §3.2).
 *
 * TODO(M1.4): field-level visibility. Doc 10 §4.1 + Q8.3 say a viewer sees only
 * `state`, while `email` / `scopes` / `sourceAccess` belong to admin+. The whole
 * view still goes out here; splitting it needs the UI to stop expecting those
 * fields, which lands with the rest of the screen work in M1.4.
 */

const ROUTE = "GET /api/catalog/google/status";

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

    const view = await container.usecases.connectGoogleDrive.getGoogleConnection({
      tenantId: ctx.tenantId,
    });

    return Response.json(view, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
