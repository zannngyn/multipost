import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { buildActiveTenantCookie } from "@/app/_lib/active-tenant-cookie";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * M1.2/M1.3b — `POST /api/me/active-tenant`: switch the working company.
 *
 * The body's `tenantId` is the ONE legitimate client-supplied tenant id left:
 * it is not a claim of authority but the OBJECT of this request ("make this my
 * selector"), and it goes straight into `requireTenant()` as the selector —
 * which checks the membership FRESH (tier S, doc 10 §4.4) and is the only
 * production constructor of a trusted tenant id. No shim, no second check:
 * the authoriser IS the endpoint's business logic.
 *
 * Refusals: a tenant the account has no active membership in (or a suspended
 * tenant, or one that does not exist) answers the same 404 TENANT_NOT_FOUND.
 */

const ROUTE = "POST /api/me/active-tenant";

const BodySchema = z.object({
  tenantId: uuidField("Mã công ty không hợp lệ."),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first ----------------------------------------------------
    const session = await getOperatorSession(`api:${ROUTE}`);
    if (!session) {
      throw new AppError("UNAUTHORIZED", {
        message: "POST /api/me/active-tenant requires a signed-in operator",
        context: { route: ROUTE },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    // Fresh membership check + branded id in one move. Throws TENANT_NOT_FOUND
    // (404) when the membership is absent/removed or the tenant is suspended.
    const ctx = await container.usecases.requireTenant(session, body.tenantId, { tier: "S" });

    container.logger.info("Active tenant switched", {
      route: ROUTE,
      tenant_id: ctx.tenantId,
      account_id: session.accountId,
      membership_role: ctx.role,
    });

    return Response.json(
      { activeTenantId: ctx.tenantId },
      {
        headers: {
          "set-cookie": buildActiveTenantCookie(ctx.tenantId, {
            // Secure would make the cookie invisible over plain http on a dev
            // box; production always sits behind Caddy's TLS.
            secure: container.config.NODE_ENV === "production",
          }),
        },
      },
    );
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
