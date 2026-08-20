import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
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
 * Auth (M1.3b, doc 10 §4.1): viewer, tier R. Tenant from
 * `requireTenantContext`; a `tenantId` still sent by an old UI build is
 * stripped and ignored (transition rule, docs/11 §3.2).
 */

const ROUTE = "GET /api/catalog/sync-status";

const QuerySchema = z.object({
  /**
   * How many history rows the rail wants. Absent = the usecase default, which
   * is SIX and not five: `recentRuns` includes the run the response already
   * describes, and the rail drops that one before showing "5 lần chạy trước".
   *
   * Coerced because a query string only ever carries text. The 1..20 literals
   * below mirror MAX_RECENT_RUNS in `core/usecases/get-sync-status.ts`, which
   * re-checks the range — the usecase owns the rule, this is the early 400 so a
   * bad query never reaches the DB. A route may only take types/error codes
   * from core (docs/07 §2), so the two stay in step by hand.
   */
  recentLimit: z.coerce
    .number({ error: "Tham số recentLimit phải là số." })
    .int("Tham số recentLimit phải là số nguyên.")
    .min(1, "Tham số recentLimit phải từ 1 đến 20.")
    .max(20, "Tham số recentLimit phải từ 1 đến 20.")
    .optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: no membership, no answer (doc 10 §3) --------------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
      minRole: "viewer",
    });

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      recentLimit: url.searchParams.get("recentLimit") ?? undefined,
    });

    // Then the query string: a bad recentLimit is a 400 before the DB sees it.
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid query string for sync status",
        userMessage: "Tham số không hợp lệ. Vui lòng thử lại.",
        context: {
          route: ROUTE,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "query",
            message: issue.message,
          })),
        },
      });
    }

    const result = await container.usecases.getSyncStatus({
      tenantId: ctx.tenantId,
      recentLimit: parsed.data.recentLimit,
    });

    if (!result) {
      return Response.json({ state: "never_synced", tenantId: ctx.tenantId });
    }

    return Response.json({ state: "has_run", run: result });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
