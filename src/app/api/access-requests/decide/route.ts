import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { ACCESS_DECISIONS, getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { OPERATOR_ROLES } from "@/shared/operator-access";

import { requireAccessAdmin } from "../_lib/admin-guard";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E1.4 — `POST /api/access-requests/decide`: approve (with a role) or block.
 *
 * The decision itself, the `app_user` row an approval implies and the audit row
 * are written in one transaction by the repo; this handler only validates,
 * names the actor and maps errors (docs/07 §3.3).
 */

const ROUTE = "POST /api/access-requests/decide";

const DecideSchema = z
  .object({
    tenantId: z
      .string({ error: "Thiếu mã đơn vị (tenant)." })
      .trim()
      .min(1, "Thiếu mã đơn vị (tenant)."),
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

    const admin = await requireAccessAdmin(ROUTE);
    const body = await readJsonBody(request, DecideSchema, { route: ROUTE });

    const result = await container.usecases.accessRequests.decideAccessRequest({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      id: body.id,
      decision: body.decision,
      role: body.role,
      // Who decided. Resolved to `app_user.id` inside the usecase; an operator
      // with no row (env bootstrap admin) still leaves the e-mail on the trail.
      actorEmail: admin.email,
    });

    return Response.json(result);
  } catch (error) {
    // Never swallowed: mapAppErrorToHttp logs every refusal with its context.
    // A refused ADMIN action is flagged for the operator log — somebody with a
    // valid session tried to decide who gets in, and that is worth reading.
    const forbidden = AppError.is(error) && error.code === "ACCESS_FORBIDDEN";
    return mapAppErrorToHttp(error, {
      logger,
      context: forbidden ? { route: ROUTE, alert: "OPERATOR_ATTENTION" } : { route: ROUTE },
    });
  }
}
