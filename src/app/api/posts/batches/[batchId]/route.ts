import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E7.5 — read model behind "Theo dõi lô": batch totals + one row per channel.
 * Polled by the browser every few seconds while jobs are still moving, so it
 * stays a plain read: no side effect, no queue call (docs/07 §3.3).
 *
 * A batch that does not belong to this tenant looks exactly like a batch that
 * does not exist (the usecase is tenant-scoped) — one 400 INVALID_INPUT with
 * `BATCH_NOT_FOUND`, no cross-tenant probing.
 */

const ROUTE = "GET /api/posts/batches/[batchId]";

const RequestSchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  /** Guarded here so a typo is a 400, not a DB cast error (see _lib/ids). */
  batchId: uuidField("Mã lô bài đăng không hợp lệ."),
});

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { batchId } = await context.params;
    const url = new URL(request.url);
    const parsed = RequestSchema.safeParse({
      tenantId: url.searchParams.get("tenantId") ?? undefined,
      batchId,
    });

    // --- Edge case first: never touch the DB with an invalid identifier -----
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid request for batch status",
        userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã lô và mã đơn vị (tenant).",
        context: {
          route: ROUTE,
          batch_id: batchId,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      });
    }

    const result = await container.usecases.getBatchStatus({
      tenantId: legacyTenantIdFromRequest(parsed.data.tenantId),
      batchId: parsed.data.batchId,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
