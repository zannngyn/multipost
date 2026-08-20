import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
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
 *
 * Auth (M1.3b, doc 10 §4.1): editor, tier S. A sync is a daily errand, so it
 * stops at editor — but it reads with the tenant's Google credential and
 * rewrites the whole catalog (`deleteStale`), so the membership is read fresh.
 *
 * The request has NO body contract any more: the only field it ever carried was
 * `tenantId`, which now comes from the session. The body is not read at all, so
 * an old UI build sending `{tenantId}` and a new one sending nothing both work
 * (transition rule, docs/11 §3.2).
 */

const ROUTE = "POST /api/catalog/sync";

export const dynamic = "force-dynamic";
/** The inline run above needs far more than the default budget. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Edge case first: authorise before spending Drive/Sheet quota -------
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "editor",
    });

    // The usecase owns everything else: missing integration row, Drive/Sheet
    // failures, the empty-source refusal, and writing the sync_run trail.
    const result = await container.usecases.syncCatalog({ tenantId: ctx.tenantId });

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
