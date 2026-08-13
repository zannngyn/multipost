import { z } from "zod";

import type { JobEnvelope, JobHandler, Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * Worker half of the reaper: turn a scheduler tick into ONE sweep.
 *
 * Thin like every handler (docs/07 §2). The two rules it enforces itself:
 *   - the payload may carry per-run overrides, and it is validated like any
 *     other external input (it comes from Redis);
 *   - a sweep that throws must not take the worker down — the queue marks the
 *     tick failed, the next tick (5 minutes later) is the retry.
 */

export const REAP_POST_JOBS_JOB_NAME = "post-job-reaper";
/** Scheduler identity: upserted on every boot, so one schedule exists. */
export const REAP_POST_JOBS_SCHEDULER_ID = "post-job-reaper-schedule";

/**
 * `.passthrough()` is NOT used on purpose: an unknown key means producer and
 * worker disagree. Every field is optional — a plain `{}` is the normal tick.
 */
export const ReapPostJobsPayloadSchema = z
  .object({
    publishingStaleMs: z.coerce.number().int().positive().optional(),
    overdueQueuedMs: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

export type ReapPostJobsPayload = z.infer<typeof ReapPostJobsPayloadSchema>;

export function parseReapPostJobsPayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): ReapPostJobsPayload {
  // A scheduler tick has no data at all; treat that as "use the defaults".
  const parsed = ReapPostJobsPayloadSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid post-job-reaper payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage: "Dữ liệu công việc quét bài kẹt không hợp lệ — công việc đã bị từ chối.",
    context: { ...context, job_name: REAP_POST_JOBS_JOB_NAME, issues },
  });
}

export interface ReapPostJobsHandlerDeps {
  logger: Logger;
  reapPostJobs: Usecases["reapPostJobs"];
}

export function makeReapPostJobsHandler(deps: ReapPostJobsHandlerDeps): JobHandler {
  return async function handleReapPostJobs(job: JobEnvelope): Promise<void> {
    const payload = parseReapPostJobsPayload(job.payload, {
      queue_job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      queue_job_id: job.jobId,
      job_name: REAP_POST_JOBS_JOB_NAME,
      attempt: job.attempt,
    });

    try {
      const result = await deps.reapPostJobs(payload);
      // The sweep logs its own detail; this line is the tick's receipt.
      log.info("post-job-reaper tick done", {
        scanned_stale_publishing: result.scannedStalePublishing,
        scanned_overdue_queued: result.scannedOverdueQueued,
        failed: result.failed,
        requeued: result.requeued,
        skipped: result.skipped,
        duration_ms: result.durationMs,
      });
    } catch (error) {
      // Logged with context and rethrown: the queue owns the tick's fate, and a
      // silent reaper is exactly the failure this job exists to prevent.
      const appError = AppError.from(error, "INTERNAL", {
        queue_job_id: job.jobId,
        job_name: REAP_POST_JOBS_JOB_NAME,
        attempt: job.attempt,
      });
      log.error("post-job-reaper tick failed", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }
  };
}
