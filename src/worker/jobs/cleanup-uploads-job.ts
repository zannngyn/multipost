import { z } from "zod";

import type { JobEnvelope, JobHandler, Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * E9.4 — worker half of the upload cleanup: turn a scheduler tick into ONE
 * sweep of uploaded files nobody posted.
 *
 * Thin like every handler (docs/07 §2). Same two rules as the reaper: the
 * payload comes from Redis and is validated like any other external input, and
 * a sweep that throws must not take the worker down — the next tick is the
 * retry.
 */

export const CLEANUP_UPLOADS_JOB_NAME = "upload-cleanup";
/** Scheduler identity: upserted on every boot, so one schedule exists. */
export const CLEANUP_UPLOADS_SCHEDULER_ID = "upload-cleanup-schedule";

export const CleanupUploadsPayloadSchema = z
  .object({
    ttlHours: z.coerce.number().int().positive().max(720).optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  })
  .strict();

export type CleanupUploadsPayload = z.infer<typeof CleanupUploadsPayloadSchema>;

export function parseCleanupUploadsPayload(
  raw: unknown,
  context: Record<string, unknown> = {},
): CleanupUploadsPayload {
  // A scheduler tick has no data at all; treat that as "use the defaults".
  const parsed = CleanupUploadsPayloadSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("JOB_PAYLOAD_INVALID", {
    message: `Invalid upload-cleanup payload: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    userMessage: "Dữ liệu công việc dọn file tải lên không hợp lệ — công việc đã bị từ chối.",
    context: { ...context, job_name: CLEANUP_UPLOADS_JOB_NAME, issues },
  });
}

export interface CleanupUploadsHandlerDeps {
  logger: Logger;
  cleanupUploads: Usecases["cleanupUploads"];
}

export function makeCleanupUploadsHandler(deps: CleanupUploadsHandlerDeps): JobHandler {
  return async function handleCleanupUploads(job: JobEnvelope): Promise<void> {
    const payload = parseCleanupUploadsPayload(job.payload, {
      queue_job_id: job.jobId,
      attempt: job.attempt,
    });

    const log = deps.logger.child({
      queue_job_id: job.jobId,
      job_name: CLEANUP_UPLOADS_JOB_NAME,
      attempt: job.attempt,
    });

    try {
      const result = await deps.cleanupUploads(payload);
      log.info("upload-cleanup tick done", {
        scanned: result.scanned,
        blobs_removed: result.blobsRemoved,
        rows_removed: result.rowsRemoved,
        tickets_scanned: result.ticketsScanned,
        tickets_removed: result.ticketsRemoved,
        ticket_list_failed: result.ticketListFailed,
        failed: result.failed,
      });
    } catch (error) {
      const appError = AppError.from(error, "INTERNAL", {
        queue_job_id: job.jobId,
        job_name: CLEANUP_UPLOADS_JOB_NAME,
        attempt: job.attempt,
      });
      log.error("upload-cleanup tick failed", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }
  };
}
