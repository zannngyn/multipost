import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";

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
 * M1.3b — viewer / tier R (doc 10 §4.2). This route WAS Bug B7's headline case:
 * it took `?tenantId=` from the query and only relied on `proxy.ts` for a
 * session, so any signed-in operator could count another tenant's stuck jobs.
 * The tenant now comes from the membership and there is no input left to parse.
 *
 * Field-level narrowing (doc 10 Q8.3) — BREAKING, agreed with ui-web:
 *
 *   `workersOnline` (a number) is gone from the tenant-facing body. It counts
 *   the replicas of the SHARED MYSP fleet, so it is neither about this tenant
 *   nor useful to it — but it IS a capacity probe: poll it from any tenant and
 *   you learn how much the platform is running and when it is being scaled.
 *   What the banner actually needs is "is anybody consuming?", so that is what
 *   it now gets: `workersAvailable: boolean`.
 *
 *   The exact count survives for the people who operate the fleet:
 *   `workersOnline` is added back only when the session carries a
 *   `platformRole` (support or super_admin, docs/09 §3.5) — a PLATFORM
 *   attribute of the person, not a role inside the tenant, so no tenant admin
 *   can grant it to themselves.
 *
 * `queueReachable` stays visible to everyone on purpose: hiding "the queue is
 * unreachable" would restore the exact silence this endpoint was built to end.
 */

const ROUTE = "GET /api/posts/worker-health";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: nothing is probed for a caller without a membership -
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
    });

    const { workersOnline, ...health } = await container.usecases.getWorkerHealth({
      tenantId: ctx.tenantId,
    });

    // `checkedAt` is a Date; Response.json serialises it to the ISO string the
    // UI schema expects.
    return Response.json({
      ...health,
      // Derived from the count, not from `queueReachable`: an unreachable broker
      // reports 0 workers, and "we could not ask" must not read as "nobody is
      // working" — `queueReachable: false` is the field that says that.
      workersAvailable: workersOnline > 0,
      // Platform staff only (doc 10 Q8.3). A tenant `owner` is NOT platform
      // staff, so the ladder inside the tenant cannot reach this.
      ...(session.platformRole !== null ? { workersOnline } : {}),
    });
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
