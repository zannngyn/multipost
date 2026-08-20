import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

/**
 * E5.1 — "Làm mới danh sách Trang" with the token already stored for this
 * tenant. Picks up Pages created since the last import and refreshes the Page
 * tokens; a tenant that never imported anything gets a CHANNEL_NOT_CONFIGURED
 * telling the operator to paste a token first.
 *
 * POST, not GET: it writes.
 *
 * M1.3b — admin / tier S (doc 10 §4.2). The body is now empty: it only ever
 * carried `tenantId`, and the tenant comes from the membership.
 */

const ROUTE = "POST /api/channels/refresh";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: admin / tier S (doc 10 §4.2). This spends a STORED
    // credential without a second paste, so it is a credential op ------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const result = await container.usecases.connectChannels.refreshChannels({
      tenantId: ctx.tenantId,
      actorEmail: session.email,
    });

    // Response shape unchanged (docs/11 §2): the UI still reads `tenantId`.
    return Response.json({
      tenantId: ctx.tenantId,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
      channels: result.channels,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
