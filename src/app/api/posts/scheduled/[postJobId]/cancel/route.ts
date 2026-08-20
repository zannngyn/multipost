import { z } from "zod";

import { fallbackLogger } from "@/app/api/_lib/fallback-logger";
import { mapAppErrorToHttp, type ErrorLogger } from "@/app/api/_lib/http-errors";
import { uuidField } from "@/app/api/_lib/ids";
import { readJsonBody } from "@/app/api/_lib/read-json-body";
import { requireTenantContext } from "@/app/api/_lib/require-tenant-context";
import { getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E8.4 — "huỷ" a scheduled post before it goes out.
 *
 * The job ends `blocked` with `lastErrorCode = OPERATOR_CANCELLED`; a job a
 * worker already claimed comes back as 409 INVALID_JOB_TRANSITION, so the
 * operator is told the truth ("đang đăng rồi") instead of believing a cancel
 * that did nothing.
 *
 * The optional note is free text from the operator: it is the answer to "vì sao
 * bài này không lên" (business rule 5) when the reason is a human decision
 * rather than a system rule.
 *
 * The note reaches `audit_log.payload` of `post_job.cancelled` as well as the
 * structured log, so the dialog may promise it is kept.
 */

const ROUTE = "POST /api/posts/scheduled/[postJobId]/cancel";

/** Long enough for a real reason, short enough not to be a pasted document. */
const MAX_NOTE_LENGTH = 500;

const BodySchema = z.object({
  note: z.string().trim().max(MAX_NOTE_LENGTH, "Ghi chú quá dài.").optional(),
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

    // --- Refusals first: editor / tier S (doc 10 §4.2). Cancelling decides
    // whether a public post happens at all ----------------------------------
    const { ctx, session } = await requireTenantContext(request, {
      surface: `api:${ROUTE}`,
      tier: "S",
      minRole: "editor",
    });

    const { postJobId } = await context.params;
    // --- Edge case first: a typo in the URL is a 400, not a DB cast error ---
    const parsedId = uuidField("Mã bài đăng không hợp lệ.").safeParse(postJobId);
    if (!parsedId.success) {
      throw new AppError("INVALID_INPUT", {
        message: "Invalid post job id in the cancel URL",
        userMessage: "Mã bài đăng không hợp lệ.",
        context: {
          route: ROUTE,
          issues: [{ path: "postJobId", message: "Mã bài đăng không hợp lệ." }],
        },
      });
    }

    const body = await readJsonBody(request, BodySchema, { route: ROUTE });
    const note = body.note?.trim() ?? "";

    const result = await container.usecases.cancelScheduledJob({
      tenantId: ctx.tenantId,
      postJobId: parsedId.data,
      actorEmail: session.email,
      note: note.length > 0 ? note : null,
    });

    container.logger.info("Scheduled post cancelled from the operator UI", {
      route: ROUTE,
      tenant_id: ctx.tenantId,
      job_id: result.postJobId,
      batch_id: result.batchId,
      channel: result.channelId,
      scheduled_at: result.scheduledAt?.toISOString() ?? null,
      queue_entry_removed: result.queueEntryRemoved,
      has_note: note.length > 0,
      actor_email: session.email,
    });

    return Response.json(result);
  } catch (error) {
    return mapAppErrorToHttp(error, { logger, context: { route: ROUTE } });
  }
}
