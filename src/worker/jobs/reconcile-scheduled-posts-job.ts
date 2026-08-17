import { z } from "zod";

import type { JobEnvelope, JobHandler, Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * Worker half of the E8.6 reconciliation sweep: one scheduler tick -> one pass
 * over the posts Facebook is holding.
 *
 * Thin like every handler (docs/07 §2): validate the payload (it comes from
 * Redis), call the usecase, log the receipt. A failing tick must not take the
 * worker down — the next tick is the retry.
 */

export const RECONCILE_SCHEDULED_POSTS_JOB_NAME = "reconcile-scheduled-posts";
/** Scheduler identity: upserted on every boot, so ONE schedule exists. */
export const RECONCILE_SCHEDULED_POSTS_SCHEDULER_ID = "reconcile-scheduled-posts-schedule";

/** `.strict()`: an unknown key means producer and worker disagree. */
export const ReconcileScheduledPostsPayloadSchema = z
  .object({
    graceMs: z.coerce.number().int().positive().optional(),
    giveUpMs: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

export type ReconcileScheduledPostsPayload = z.infer<typeof ReconcileScheduledPostsPayloadSchema>;

export function parseReconcileScheduledPostsPayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): ReconcileScheduledPostsPayload {
  // A scheduler tick may carry no data at all: that means "use the defaults".
  const parsed = ReconcileScheduledPostsPayloadSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid reconcile-scheduled-posts payload: ${issues
      .map((i) => `${i.path} ${i.message}`)
      .join("; ")}`,
    userMessage: "Dữ liệu công việc đối soát bài đã hẹn không hợp lệ — công việc đã bị từ chối.",
    context: { ...context, job_name: RECONCILE_SCHEDULED_POSTS_JOB_NAME, issues },
  });
}

export interface ReconcileScheduledPostsHandlerDeps {
  logger: Logger;
  reconcileScheduledPosts: Usecases["reconcileScheduledPosts"];
}

export function makeReconcileScheduledPostsHandler(
  deps: ReconcileScheduledPostsHandlerDeps,
): JobHandler {
  return async function handleReconcileScheduledPosts(job: JobEnvelope): Promise<void> {
    const payload = parseReconcileScheduledPostsPayload(job.payload, {
      queue_job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      queue_job_id: job.jobId,
      job_name: RECONCILE_SCHEDULED_POSTS_JOB_NAME,
      attempt: job.attempt,
    });

    try {
      const result = await deps.reconcileScheduledPosts(payload);
      // The sweep logs its own detail; this line is the tick's receipt.
      log.info("reconcile-scheduled-posts tick done", {
        scanned: result.scanned,
        published: result.published,
        waiting: result.waiting,
        failed: result.failed,
        skipped: result.skipped,
        duration_ms: result.durationMs,
      });
    } catch (error) {
      // Logged with context and rethrown: a silent reconciler means posts that
      // are live on Facebook stay "đang chờ" on our screens forever.
      const appError = AppError.from(error, "INTERNAL", {
        queue_job_id: job.jobId,
        job_name: RECONCILE_SCHEDULED_POSTS_JOB_NAME,
        attempt: job.attempt,
      });
      log.error("reconcile-scheduled-posts tick failed", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }
  };
}
