import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { legacyTenantIdFromRequest } from "@/composition/legacy-tenant-id";

/**
 * E8.4 — "đổi giờ" a post that has not gone out yet.
 *
 * Only a `queued` job whose hour is still ahead can move; the usecase refuses
 * everything else with the reason (409 INVALID_JOB_TRANSITION:
 * SCHEDULE_ALREADY_DUE / NOT_QUEUED / CONCURRENT_MODIFICATION), and a time in
 * the past or beyond the 30-day window is a 400.
 *
 * QUEUE_ERROR (503) is the one outcome that is NOT a clean refusal: the new
 * hour is already stored but nothing was queued for it. The screen has its own
 * warning for that case — it must not read as "đổi giờ thất bại", because the
 * row HAS changed.
 *
 * Who moved it is read from the SESSION, never from the body (same contract as
 * retry): the usecase resolves the e-mail to an `app_user.id` for the audit row.
 */

const ROUTE = "POST /api/posts/scheduled/[postJobId]/reschedule";

const BodySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
  /** An INSTANT. The browser converts the operator's wall clock into it. */
  scheduledAt: z.iso.datetime({ error: "Giờ hẹn đăng không hợp lệ." }),
});

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ postJobId: string }> },
): Promise<Response> {
  let logger: ErrorLogger = fallbackLogger;

  try {
    const container = getContainer();
    logger = container.logger;

    const { postJobId } = await context.params;
    // --- Edge case first: a typo in the URL is a 400, not a DB cast error ---
    const parsedId = uuidField("Mã bài đăng không hợp lệ.").safeParse(postJobId);
    if (!parsedId.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid post job id in the reschedule URL",
        userMessage: "Mã bài đăng không hợp lệ.",
        context: {
          route: ROUTE,
          issues: [{ path: "postJobId", message: "Mã bài đăng không hợp lệ." }],
        },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    // Defence in depth: middleware already guards /api, but the actor must come
    // from the real session, not from a hopeful client.
    const session = await getOperatorSession(`api:${ROUTE}`);

    const result = await container.usecases.reschedulePostJob({
      tenantId: legacyTenantIdFromRequest(body.tenantId),
      postJobId: parsedId.data,
      newScheduledAt: new Date(body.scheduledAt),
      actorEmail: session?.email ?? null,
    });

    container.logger.info("Scheduled post moved from the operator UI", {
      route: ROUTE,
      tenant_id: body.tenantId,
      job_id: result.postJobId,
      batch_id: result.batchId,
      channel: result.channelId,
      previous_scheduled_at: result.previousScheduledAt?.toISOString() ?? null,
      scheduled_at: result.scheduledAt.toISOString(),
      previous_queue_entry_removed: result.previousQueueEntryRemoved,
      actor_email: session?.email ?? null,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
