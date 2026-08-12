import { z } from "zod";

import {
  PUBLISH_POST_JOB_NAME,
  type JobEnvelope,
  type JobHandler,
  type Logger,
  type Usecases,
} from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * Worker half of E5/E7: turn a queue message into one publish attempt.
 *
 * The handler stays thin (docs/07 §2): validate the payload, call the usecase,
 * log the outcome. Every business rule — anti-duplicate claim, stock recheck,
 * spacing, retry policy — lives in core/usecases/publish-post.ts.
 *
 * `attempt`/`maxAttempts` are forwarded because BullMQ, not the usecase, knows
 * whether another attempt will happen; the usecase uses that to decide between
 * "back to queued" and "failed".
 */

export { PUBLISH_POST_JOB_NAME };

/** `.strict()`: an unknown key means producer and worker disagree — fail loudly. */
export const PublishPostPayloadSchema = z
  .object({
    tenantId: z.string().trim().min(1, "tenantId must not be empty"),
    postJobId: z.string().trim().min(1, "postJobId must not be empty"),
  })
  .strict();

export type PublishPostPayload = z.infer<typeof PublishPostPayloadSchema>;

/** Job data comes from Redis — external input, never trusted. */
export function parsePublishPostPayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): PublishPostPayload {
  const parsed = PublishPostPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid publish-post payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage: "Dữ liệu công việc đăng bài không hợp lệ — công việc đã bị từ chối, không thử lại.",
    context: { ...context, job_name: PUBLISH_POST_JOB_NAME, issues },
  });
}

export interface PublishPostHandlerDeps {
  logger: Logger;
  publishPost: Usecases["publishPost"];
}

export function makePublishPostHandler(deps: PublishPostHandlerDeps): JobHandler {
  return async function handlePublishPost(job: JobEnvelope): Promise<void> {
    // Thrown before any logger.child({ tenant_id }): nothing here is trustworthy yet.
    const payload = parsePublishPostPayload(job.payload, {
      job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      queue_job_id: job.jobId,
      job_name: PUBLISH_POST_JOB_NAME,
      tenant_id: payload.tenantId,
      job_id: payload.postJobId,
      attempt: job.attempt,
      max_attempts: job.maxAttempts,
    });

    try {
      const result = await deps.publishPost({
        tenantId: payload.tenantId,
        postJobId: payload.postJobId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      });

      // A blocked/skipped outcome is a FINISHED job, not a queue failure: the
      // reason is on the post_job row and retrying would change nothing.
      log.info("publish-post job done", {
        outcome: result.outcome,
        post_status: result.status,
        channel: result.channelId,
        product_code: result.productCode,
        batch_id: result.batchId,
        published_post_id: result.publishedPostId,
        published_url: result.publishedUrl,
        error_code: result.errorCode,
        user_message: result.userMessage,
        deferred_ms: result.deferredMs,
      });
    } catch (error) {
      // Never swallowed: log with context, then rethrow so the queue adapter
      // decides retry vs. unrecoverable from the error CODE alone.
      const appError = AppError.from(error, "INTERNAL", {
        queue_job_id: job.jobId,
        job_name: PUBLISH_POST_JOB_NAME,
        tenant_id: payload.tenantId,
        job_id: payload.postJobId,
        attempt: job.attempt,
        max_attempts: job.maxAttempts,
      });
      log.error("publish-post job failed", {
        err: appError,
        error_code: appError.code,
        user_message: appError.userMessage,
      });
      throw appError;
    }
  };
}
