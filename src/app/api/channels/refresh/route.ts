import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E5.1 — "Làm mới danh sách Trang" with the token already stored for this
 * tenant. Picks up Pages created since the last import and refreshes the Page
 * tokens; a tenant that never imported anything gets a CHANNEL_NOT_CONFIGURED
 * telling the operator to paste a token first.
 *
 * POST, not GET: it writes.
 */

const ROUTE = "POST /api/channels/refresh";

const RefreshSchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, RefreshSchema, { route: ROUTE });
    const session = await getOperatorSession(`api:${ROUTE}`);

    const result = await container.usecases.connectChannels.refreshChannels({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      actorEmail: session?.email ?? null,
    });

    return Response.json({
      tenantId: result.tenantId,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
      channels: result.channels,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
