import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

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
 *
 * Auth (M1.3b, doc 10 §4.1): admin, tier S — it destroys a credential.
 *
 * No body contract any more: `tenantId` was its only field and now comes from
 * the session, so the body is not read at all. An old UI build that still sends
 * `{tenantId}` and a new one that sends nothing both work (docs/11 §3.2).
 */

const ROUTE = "DELETE /api/catalog/google/connection";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: fresh membership before a credential is destroyed -
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "admin",
    });

    const view = await container.usecases.connectGoogleDrive.disconnectGoogle({
      tenantId: ctx.tenantId,
      actorEmail: session.email,
    });

    return Response.json(view, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
