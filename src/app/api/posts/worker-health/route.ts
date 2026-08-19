import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E11 — "có ai đang xử lý hàng đợi không?" for the job log banner.
 *
 * The bug this answers: a post sits `queued` with `attempt_count: 0` and no
 * error because no worker process is running. The job log alone cannot tell
 * that apart from a job about to be picked up, so the screen asks here.
 *
 * A dead queue is a 200, not a 503: `queueReachable: false` IS the answer the
 * banner needs. The usecase never throws for that reason — an error status here
 * would mean the check itself broke (bad input, container failing to build).
 *
 * Thin by contract (docs/07 §3.3): validate, delegate, map errors.
 * Auth: `proxy.ts` already requires a session on every /api/* path outside its
 * public list, so this handler only owns input validation.
 */

const ROUTE = "GET /api/posts/worker-health";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const query = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({ tenantId: query.get("tenantId") ?? undefined });

    // --- Edge case first: reject bad input before probing anything ----------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the worker healthcheck",
        userMessage: "Thiếu mã đơn vị (tenant) để kiểm tra tình trạng máy đăng bài.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "tenantId",
            message: issue.message,
          })),
        },
      });
    }

    const result = await container.usecases.getWorkerHealth({ tenantId: parsed.data.tenantId });

    // `checkedAt` is a Date; Response.json serialises it to the ISO string the
    // UI schema expects.
    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
