import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * Walking-skeleton endpoint: UI -> here -> composition -> usecase -> Drizzle
 * -> Postgres. Thin by contract (docs/07 §3.3): validate, delegate, map errors.
 * No business branching lives in this file.
 *
 * Auth: covered by `middleware.ts` (every /api/* path outside the public list
 * needs a session). This handler therefore only owns input validation.
 */

const ROUTE = "GET /api/tenants/health";

/** Query contract. Kept here, at the boundary — never trust the caller. */
const QuerySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu tham số tenantId." })
    .trim()
    .min(1, "Thiếu tham số tenantId."),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
    });

    // --- Edge case first: reject bad input before touching the DB -----------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for tenant healthcheck",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant).",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    // The usecase owns the remaining rules (UUID shape, existence, DB errors).
    const result = await container.usecases.healthcheckTenant({ tenantId: parsed.data.tenantId });
    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
