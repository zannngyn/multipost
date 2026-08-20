import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

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

    // --- Refusals first: admin / tier S (doc 10 §4.2). A raw credential is
    // about to be sealed into this tenant, so the membership is read fresh ---
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const body = await readJsonBody(request, ImportSchema, { route: ROUTE });

    const result = await container.usecases.connectChannels.importChannels({
      tenantId: ctx.tenantId,
      userAccessToken: body.userAccessToken,
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
    // The token never reaches this line: the usecase keeps it out of every
    // AppError context, so the log stays safe to keep.
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
