import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E2 — "Ngắt kết nối Google".
 *
 * Revokes the grant at Google (best effort: a revoke Google refuses is logged
 * as a warning, never a blocker — a connection the operator cannot get rid of
 * would be worse), then removes the credential from `tenant_integration` and
 * writes the audit row.
 *
 * Idempotent by contract: disconnecting twice answers `not_connected` twice.
 * The actor's e-mail comes from the SESSION, never from the body — a caller
 * must not be able to write someone else's name into the audit trail.
 */

const ROUTE = "DELETE /api/catalog/google/connection";

const BodySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
});

export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const session = await getOperatorSession(`api:${ROUTE}`);

    const view = await container.usecases.connectGoogleDrive.disconnectGoogle({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      actorEmail: session?.email ?? null,
    });

    return Response.json(view, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
