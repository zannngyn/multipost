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
 * M1.2 — `POST /api/me/active-tenant`: switch the working company.
 *
 * Tier S (doc 10 §4.4): the membership is read FRESH inside the usecase before
 * any cookie is written. The cookie itself is only a SELECTOR — every later
 * request re-checks the membership — but handing out a selector for a company
 * the person is not in would still make the UI lie for up to a TTL.
 * A tenant the account has no active membership in answers 404
 * TENANT_NOT_FOUND, indistinguishable from a tenant that does not exist.
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
    const result = await container.usecases.selectActiveTenant({
      sessionEmail: session.email,
      tenantId: body.tenantId,
    });

    return Response.json(result, {
      headers: {
        "set-cookie": buildActiveTenantCookie(result.activeTenantId, {
          // Secure would make the cookie invisible over plain http on a dev
          // box; production always sits behind Caddy's TLS.
          secure: container.config.NODE_ENV === "production",
        }),
      },
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
