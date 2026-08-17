import { z } from "zod";

import type { JobEnvelope, JobHandler, Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * E3.6 — worker half of the Drive byte cache sweep: turn a scheduler tick into
 * ONE pass over the cache volume.
 *
 * Thin like every handler (docs/07 section 2). Same two rules as the upload
 * cleanup: the payload comes from Redis and is validated like any other external
 * input, and a sweep that throws must not take the worker down — the next tick
 * is the retry.
 */

export const CLEANUP_MEDIA_CACHE_JOB_NAME = "media-cache-cleanup";
/** Scheduler identity: upserted on every boot, so one schedule exists. */
export const CLEANUP_MEDIA_CACHE_SCHEDULER_ID = "media-cache-cleanup-schedule";

export const CleanupMediaCachePayloadSchema = z
  .object({
    ttlHours: z.coerce.number().int().positive().max(720).optional(),
    limit: z.coerce.number().int().positive().max(100_000).optional(),
  })
  .strict();

export type CleanupMediaCachePayload = z.infer<typeof CleanupMediaCachePayloadSchema>;

export function parseCleanupMediaCachePayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): CleanupMediaCachePayload {
  // A scheduler tick has no data at all; treat that as "use the defaults".
  const parsed = CleanupMediaCachePayloadSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid media-cache-cleanup payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage: "Dữ liệu công việc dọn bộ nhớ đệm ảnh không hợp lệ — công việc đã bị từ chối.",
    context: { ...context, job_name: CLEANUP_MEDIA_CACHE_JOB_NAME, issues },
  });
}

export interface CleanupMediaCacheHandlerDeps {
  logger: Logger;
  cleanupMediaCache: Usecases["cleanupMediaCache"];
}

export function makeCleanupMediaCacheHandler(deps: CleanupMediaCacheHandlerDeps): JobHandler {
  return async function handleCleanupMediaCache(job: JobEnvelope): Promise<void> {
    const payload = parseCleanupMediaCachePayload(job.payload, {
      queue_job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      queue_job_id: job.jobId,
      job_name: CLEANUP_MEDIA_CACHE_JOB_NAME,
      attempt: job.attempt,
    });

    try {
      const result = await deps.cleanupMediaCache(payload);
      log.info("media-cache-cleanup tick done", {
        scanned: result.scanned,
        removed: result.removed,
        failed: result.failed,
      });
    } catch (error) {
      const appError = AppError.from(error, "INTERNAL", {
        queue_job_id: job.jobId,
        job_name: CLEANUP_MEDIA_CACHE_JOB_NAME,
        attempt: job.attempt,
      });
      log.error("media-cache-cleanup tick failed", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }
  };
}
