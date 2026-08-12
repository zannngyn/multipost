import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * Read model behind the "Đồng bộ dữ liệu" screen (E2).
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * A tenant that has never synced is NOT an error: the usecase answers `null`
 * and this route turns it into a 200 with `state: "never_synced"`, so the UI
 * shows an empty state with a call to action instead of a red box.
 *
 * Auth: enforced by `middleware.ts` for every non-public /api path.
 */

const ROUTE = "GET /api/catalog/sync-status";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
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
        message: "Invalid query string for sync status",
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

    const result = await container.usecases.getSyncStatus({ tenantId: parsed.data.tenantId });

    if (!result) {
      return Response.json({ state: "never_synced", tenantId: parsed.data.tenantId });
    }

    return Response.json({ state: "has_run", run: result });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
