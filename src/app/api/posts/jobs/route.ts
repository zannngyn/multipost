import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E11.1 — the operator job log: every post_job of a tenant, newest first,
 * with the Vietnamese reason a job is not live and whether it can be re-run.
 *
 * Cursor pagination, not offset: this list changes while it is being read (the
 * worker keeps publishing), and an offset page would silently skip or repeat
 * rows. The cursor is opaque here — it is minted and decoded by the usecase.
 *
 * An unknown `status` is a 400, never "everything": a filtered screen that
 * quietly shows all rows is worse than an error.
 */

const ROUTE = "GET /api/posts/jobs";

const QuerySchema = z.object({
  /** Validated against the domain state machine inside the usecase. */
  status: z.string().trim().min(1).max(32).optional(),
  /** A uuid column: a typo must be a 400, not a DB cast error (see _lib/ids). */
  batchId: uuidField("Mã lô bài đăng không hợp lệ.").optional(),
  channelId: z.string().trim().min(1).max(128).optional(),
  productCode: z.string().trim().min(1).max(64).optional(),
  cursor: z.string().trim().min(1).max(512).optional(),
  /** The usecase clamps the value; this only rejects "abc". */
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: viewer / tier R (doc 10 §4.2) ----------------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
    });

    const query = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({
      status: query.get("status") ?? undefined,
      batchId: query.get("batchId") ?? undefined,
      channelId: query.get("channelId") ?? undefined,
      productCode: query.get("productCode") ?? undefined,
      cursor: query.get("cursor") ?? undefined,
      limit: query.get("limit") ?? undefined,
    });

    // --- Edge case first ----------------------------------------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the post job log",
        userMessage: "Bộ lọc nhật ký đăng bài không hợp lệ. Vui lòng kiểm tra lại.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      });
    }

    const result = await container.usecases.listPostJobs({
      tenantId: ctx.tenantId,
      filter: parsed.data,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
