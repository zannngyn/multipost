import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E8.4 — "bài đã hẹn": what is going to publish, soonest first. READ ONLY.
 * Thin by contract (docs/07 §3.3): validate -> usecase -> map errors.
 *
 * The opposite order of the job log on purpose: this screen answers "cái gì
 * sắp lên?", so the next event belongs at the top. A job whose hour already
 * passed while still queued is INCLUDED and flagged `overdue` by the usecase —
 * hiding it is how a stuck schedule stays invisible (business rule 5).
 *
 * `from`/`to` are INSTANTS (ISO), not days: the browser owns the operator's
 * timezone and converts "cả ngày 13/08" into the two instants that bound it.
 */

const ROUTE = "GET /api/posts/scheduled";

const QuerySchema = z.object({
  tenantId: z.string({ error: "Thiếu tham số tenantId." }).trim().min(1, "Thiếu tham số tenantId."),
  /** Inclusive lower bound. */
  from: z.iso.datetime({ error: "Khoảng thời gian lọc không hợp lệ." }).optional(),
  /** Exclusive upper bound; the usecase refuses a window that ends before it starts. */
  to: z.iso.datetime({ error: "Khoảng thời gian lọc không hợp lệ." }).optional(),
  channelId: z.string().trim().min(1).max(128).optional(),
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

    const query = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({
      tenantId: query.get("tenantId") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      channelId: query.get("channelId") ?? undefined,
      cursor: query.get("cursor") ?? undefined,
      limit: query.get("limit") ?? undefined,
    });

    // --- Edge case first ----------------------------------------------------
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for the scheduled post list",
        userMessage: "Bộ lọc bài đã hẹn không hợp lệ. Vui lòng kiểm tra lại.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "(root)",
            message: issue.message,
          })),
        },
      });
    }

    const { tenantId, ...filter } = parsed.data;
    const result = await container.usecases.listScheduledJobs({ tenantId, filter });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
