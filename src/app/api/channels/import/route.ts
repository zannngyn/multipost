import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E5.1, door B — import Fanpages from a User Access Token the operator pasted.
 *
 * It exists because a Meta app hands out a working user token long before its
 * App Secret is available, and waiting for the secret would mean not publishing
 * at all. Same core as the OAuth callback: one Page listing, one upsert.
 *
 * SECURITY — the token is in the POST BODY and nowhere else:
 *   - never a query string (URLs land in access logs and browser history);
 *   - never logged, never in an AppError context, never in the response;
 *   - stored SEALED in tenant_integration so "làm mới" needs no second paste.
 */

const ROUTE = "POST /api/channels/import";
/** Facebook user tokens are ~200 chars; the ceiling only stops absurd bodies. */
const MAX_TOKEN_LENGTH = 4096;

const ImportSchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
  userAccessToken: z
    .string({ error: "Thiếu User Access Token của Facebook." })
    .trim()
    .min(1, "Dán User Access Token của Facebook vào ô này.")
    .max(MAX_TOKEN_LENGTH, "User Access Token không hợp lệ (quá dài)."),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, ImportSchema, { route: ROUTE });
    const session = await getOperatorSession(`api:${ROUTE}`);

    const result = await container.usecases.connectChannels.importChannels({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      userAccessToken: body.userAccessToken,
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
    // The token never reaches this line: the usecase keeps it out of every
    // AppError context, so the log stays safe to keep.
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
