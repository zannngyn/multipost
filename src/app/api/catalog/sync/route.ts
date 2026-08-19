import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";

/**
 * Starts one catalog sync (E2). Thin by contract (docs/07 §3.3).
 *
 * TODO(E2/E7): Phase 1 runs the sync INLINE inside the request. It walks a few
 * thousand Drive files and can take minutes; the operator's browser holds the
 * connection open and a deploy mid-run kills it. Once BullMQ carries catalog
 * jobs, this handler must only enqueue and answer 202 with the `sync_run` id —
 * the UI already polls `GET /api/catalog/sync-status`, so the screen needs no
 * change. Do not add more work to this handler in the meantime.
 *
 * Errors surface as-is: with no Service Account configured the composition root
 * throws INVALID_INPUT naming the missing env var (or DRIVE_ERROR/SHEET_ERROR
 * once credentials exist but access is refused). Both reach the operator with a
 * Vietnamese message — that is the correct behaviour, not a bug to hide.
 */

const ROUTE = "POST /api/catalog/sync";

const BodySchema = z.object({
  tenantId: z.string({ error: "Thiếu mã đơn vị (tenant)." }).trim().min(1, "Thiếu mã đơn vị (tenant)."),
});

export const dynamic = "force-dynamic";
/** The inline run above needs far more than the default budget. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });

    // The usecase owns everything else: tenant shape, missing integration row,
    // Drive/Sheet failures, and writing the sync_run trail.
    const result = await container.usecases.syncCatalog({ tenantId: body.tenantId });

    return Response.json({
      syncRunId: result.syncRunId,
      status: result.status,
      counts: result.counts,
      issues: result.issues,
      issueGroups: result.issueGroups,
      schemaDrift: result.schemaDrift,
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
