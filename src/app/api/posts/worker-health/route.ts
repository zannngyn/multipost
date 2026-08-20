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
 * TODO(M1.4, doc 10 Q8.3): `workersOnline` is a FLEET-wide replica count and
 * belongs to admin+/platform; a tenant caller should see a boolean instead. The
 * response shape is frozen here on purpose — the UI schema lands with M1.4.
 */

const ROUTE = "GET /api/posts/worker-health";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    // --- Refusals first: nothing is probed for a caller without a membership -
    const { ctx } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "R",
    });

    const result = await container.usecases.getWorkerHealth({ tenantId: ctx.tenantId });

    // `checkedAt` is a Date; Response.json serialises it to the ISO string the
    // UI schema expects.
    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
