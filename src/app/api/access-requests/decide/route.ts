import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { ACCESS_DECISIONS, getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { OPERATOR_ROLES } from "@/shared/operator-access";

import { requireAccessAdmin } from "../_lib/admin-guard";

/**
 * E1.4 / M1.3b — `POST /api/access-requests/decide`: approve (with a role) or
 * block. The tenant comes from the GUARD (tier S — deciding who gets in is not
 * undoable), never from the body; a `tenantId` field an old client still sends
 * is stripped by the schema and ignored (transition rule, docs/11 §3.2).
 *
 * The decision itself, the account/membership chain an approval implies and
 * the audit row are written in one transaction by the repo; this handler only
 * validates, names the actor and maps errors (docs/07 §3.3).
 */

const ROUTE = "POST /api/access-requests/decide";

const DecideSchema = z.object({
  id: uuidField("Mã yêu cầu truy cập không hợp lệ."),
  decision: z.enum(ACCESS_DECISIONS, { error: "Quyết định không hợp lệ (duyệt hoặc chặn)." }),
  /** Required only for `approve`; refined below rather than always demanded. */
  role: z.enum(OPERATOR_ROLES, { error: "Vai trò không hợp lệ." }).optional(),
})
  .refine((body) => body.decision !== "approve" || body.role !== undefined, {
    error: "Phải chọn vai trò khi duyệt tài khoản.",
    path: ["role"],
  });

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { session, tenantId } = await requireAccessAdmin(request, {
      route: ROUTE,
      tier: "S",
    });
    const body = await readJsonBody(request, DecideSchema, { route: ROUTE });

    const result = await container.usecases.accessRequests.decideAccessRequest({
      tenantId,
      id: body.id,
      decision: body.decision,
      role: body.role,
      // Who decided. Resolved to `app_user.id` inside the usecase; an operator
      // with no row (env bootstrap admin) still leaves the e-mail on the trail.
      actorEmail: session.email,
    });

    return Response.json(result);
  } catch (error) {
    // Never swallowed: mapAppErrorToHttp logs every refusal with its context.
    // A refused ADMIN action is flagged for the operator log — somebody with a
    // valid session tried to decide who gets in, and that is worth reading.
    const forbidden =
      AppError.is(error) && (error.code === "ACCESS_FORBIDDEN" || error.code === "FORBIDDEN");
    return mapAppErrorToHttp(error, {
      logger,
      context: forbidden ? { route: ROUTE, alert: "OPERATOR_ATTENTION" } : { route: ROUTE },
    });
  }
}
