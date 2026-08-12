import { z } from "zod";

import { getOperatorSession } from "@/app/_auth/session";
import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E11.1 — "Chạy lại" one job. Only `failed` and `blocked` may be re-queued;
 * anything else comes back as 409 INVALID_JOB_TRANSITION with the reason, so a
 * published post can never be posted twice from this screen.
 *
 * The retry does NOT skip any rule: the worker re-checks stock before the Graph
 * call (business rule 3), so a job blocked for "hết hàng" that is retried while
 * the sheet still says 0 goes straight back to `blocked`.
 *
 * Who re-ran it is read from the SESSION, never from the body. It is logged
 * (structured, with the job id) rather than written to `audit_log.actor_user_id`:
 * that column is a FK to `app_user.id` and the session only carries an e-mail —
 * mapping one to the other needs a usecase this epic does not own.
 * NOTE(orchestrator): E10.4 / auth epic should expose that lookup so the audit
 * row names the operator too.
 */

const ROUTE = "POST /api/posts/jobs/[postJobId]/retry";

const BodySchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
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
        message: "Invalid post job id in the retry URL",
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

    const result = await container.usecases.retryPostJob({
      tenantId: body.tenantId,
      postJobId: parsedId.data,
    });

    container.logger.info("Post job re-queued from the operator UI", {
      route: ROUTE,
      tenant_id: body.tenantId,
      job_id: result.postJobId,
      batch_id: result.batchId,
      channel: result.channelId,
      product_code: result.productCode,
      previous_status: result.previousStatus,
      actor_email: session?.email ?? null,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
