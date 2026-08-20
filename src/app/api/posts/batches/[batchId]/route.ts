import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E7.5 — read model behind "Theo dõi lô": batch totals + one row per channel.
 * Polled by the browser every few seconds while jobs are still moving, so it
 * stays a plain read: no side effect, no queue call (docs/07 §3.3).
 *
 * M1.3b — viewer / tier R (doc 10 §4.2): the tenant comes from the membership,
 * never from `?tenantId=`. A batch of another tenant and a batch that does not
 * exist give the SAME answer — now 404 BATCH_NOT_FOUND (Bug B5), so the status
 * code finally matches the meaning the usecase always had.
 */

const ROUTE = "GET /api/posts/batches/[batchId]";

/** Guarded here so a typo is a 400, not a DB cast error (see _lib/ids). */
const BatchIdSchema = uuidField("Mã lô bài đăng không hợp lệ.");

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: authorise before parsing anything (doc 10 §3), so a
    // caller with no membership learns nothing about our input rules ---------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
    });

    const { batchId } = await context.params;
    const parsed = BatchIdSchema.safeParse(batchId);
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid batch id for batch status",
        userMessage: "Mã lô bài đăng không hợp lệ.",
        context: {
          route: ROUTE,
          batch_id: batchId,
          issues: [{ path: "batchId", message: "Mã lô bài đăng không hợp lệ." }],
        },
      });
    }

    const result = await container.usecases.getBatchStatus({
      tenantId: ctx.tenantId,
      batchId: parsed.data,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
