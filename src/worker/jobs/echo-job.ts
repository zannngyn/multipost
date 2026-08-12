import { z } from "zod";

import type { JobEnvelope, JobHandler, Logger } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * Demo job proving the worker plumbing end to end: schema validation at the
 * boundary, retry + backoff, and non-retryable payload errors.
 * Real jobs (publish-post, sync-catalog) replace it in E5/E2.
 */

export const ECHO_JOB_NAME = "echo";

export const EchoPayloadSchema = z
  .object({
    message: z.string().trim().min(1, "message must not be empty"),
    /** Fail the first N attempts on purpose (demo of retry + backoff). */
    failTimes: z.number().int().min(0).max(10).optional(),
  })
  .strict();

export type EchoPayload = z.infer<typeof EchoPayloadSchema>;

/**
 * Job data comes from Redis — it is external input, never trusted.
 * A bad payload is a permanent failure: AppError('JOB_PAYLOAD_INVALID') is in the
 * consumer's non-retryable set, so BullMQ fails it without burning retries.
 */
export function parseEchoPayload(raw: unknown, context: Record<string, unknown> = {}): EchoPayload {
  const parsed = EchoPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid echo payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage: "Dữ liệu công việc echo không hợp lệ — công việc đã bị từ chối, không thử lại.",
    context: { ...context, job_name: ECHO_JOB_NAME, issues },
  });
}

export function makeEchoHandler(logger: Logger): JobHandler {
  return async function handleEcho(job: JobEnvelope): Promise<void> {
    const payload = parseEchoPayload(job.payload, { job_id: job.jobId });

    const failTimes = payload.failTimes ?? 0;
    const failuresSoFar = job.attempt - 1;
    if (failuresSoFar < failTimes) {
      // Retryable on purpose: proves attempts + exponential backoff really run.
      throw new AppError("INTERNAL", {
        message: `Simulated failure ${job.attempt}/${failTimes} for echo job`,
        userMessage: "Công việc echo lỗi giả lập để kiểm thử cơ chế thử lại.",
        context: { job_id: job.jobId, attempt: job.attempt, fail_times: failTimes },
      });
    }

    logger.info("echo job done", {
      job_id: job.jobId,
      attempt: job.attempt,
      message: payload.message,
    });
  };
}
