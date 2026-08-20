import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { ACCESS_STATUSES } from "@/shared/operator-access";

import { requireAccessAdmin } from "./_lib/admin-guard";

/**
 * E1.4 / M1.3b — the approval queue: `GET /api/access-requests?status=`.
 *
 * The tenant comes from the GUARD (bootstrap → registry tenant; member →
 * their active tenant, admin+, tier R), never from the query string. A
 * `tenantId` param an old client still sends is ignored (transition rule,
 * docs/11 §3.2). Thin by contract (docs/07 §3.3).
 */

const ROUTE_GET = "GET /api/access-requests";

const QuerySchema = z.object({
  /** Absent means `pending` — the only list an admin normally acts on. */
  status: z.enum([...ACCESS_STATUSES, "all"], { error: "Bộ lọc trạng thái không hợp lệ." }).optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // Authorisation BEFORE anything is read: an unauthorised caller must not be
    // able to learn even that a tenant id exists.
    const { session, tenantId } = await requireAccessAdmin(request, {
      route: ROUTE_GET,
      tier: "R",
    });

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });

    // --- Edge case first ----------------------------------------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for access requests",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại.",
        context: {
          route: ROUTE_GET,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      });
    }

    const items = await container.usecases.accessRequests.listAccessRequests({
      tenantId,
      status: parsed.data.status,
    });

    container.logger.debug("Access requests read", {
      route: ROUTE_GET,
      tenant_id: tenantId,
      actor_email: session.email,
      row_count: items.length,
    });

    return Response.json({ items });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE_GET } });
  }
}
