import { AppError } from "@/core/domain/errors";
import { transitionPostJob, type PostJob } from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { UserRepo } from "@/core/ports/user-repo";

import { resolveActorUserId, type ActorInput } from "./resolve-actor";

/**
 * E8.4 — "huỷ" a post before it goes out.
 *
 * The job ends `blocked` with the error code OPERATOR_CANCELLED.
 * PENDING(E8-cancel-status): `blocked` is reused instead of adding a `cancelled`
 * state, because the state machine and the DB enum are shared with Phase 1 and a
 * new state costs a migration plus every exhaustive switch. `blocked` already
 * means "a rule said no, nothing was sent"; the code and the audit action carry
 * WHO said no. Proposal for the orchestrator: promote it to its own status when
 * the operator screens need to filter cancellations separately.
 *
 * Order — database FIRST, queue second:
 *   1. `queued -> blocked` with the optimistic guard. If a worker already
 *      claimed the job, 0 rows change and the operator is told the truth
 *      ("đang đăng rồi") instead of believing a cancel that did nothing.
 *   2. remove the delayed queue entry. If it fires anyway (removal failed, or
 *      the message was already in flight), publish-post's status guard sees a
 *      row that is no longer `queued` and stops without calling the platform.
 */

export const CANCELLED_ERROR_CODE = "OPERATOR_CANCELLED";
/** Operator notes are free text from a form: cap them before they reach a row. */
export const MAX_CANCEL_NOTE_LENGTH = 500;
export const CANCELLED_AUDIT_ACTION = "post_job.cancelled";

export interface CancelScheduledJobInput extends ActorInput {
  readonly tenantId: string;
  readonly postJobId: string;
  /** Free-text note from the operator, stored in the audit payload. */
  readonly note?: string | null;
}

export interface CancelScheduledJobResult {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly batchId: string;
  readonly channelId: string;
  readonly status: "blocked";
  readonly scheduledAt: Date | null;
  /** False when the delayed entry could not be dropped (harmless, see above). */
  readonly queueEntryRemoved: boolean;
  readonly userMessage: string;
}

export interface CancelScheduledJobDeps {
  postJobs: PostJobRepo;
  queue: JobQueue;
  logger: Logger;
  users?: UserRepo;
}

export function makeCancelScheduledJob(deps: CancelScheduledJobDeps) {
  return async function cancelScheduledJob(
    input: CancelScheduledJobInput,
  ): Promise<CancelScheduledJobResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = str(input?.tenantId);
    const postJobId = str(input?.postJobId);
    if (!isTenantId(tenantId) || postJobId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "cancelScheduledJob requires a tenant UUID and a post job id",
        userMessage: "Yêu cầu huỷ bài hẹn thiếu thông tin định danh.",
        context: { tenant_id: tenantId || null, post_job_id: postJobId || null },
      });
    }

    const job = await deps.postJobs.findJobById(tenantId, postJobId);
    if (!job) {
      throw new AppError("INVALID_INPUT", {
        message: "Post job not found",
        userMessage: "Không tìm thấy bài đăng cần huỷ.",
        context: { tenant_id: tenantId, post_job_id: postJobId, reason: "POST_JOB_NOT_FOUND" },
      });
    }

    const log = deps.logger.child({
      tenant_id: tenantId,
      job_id: job.id,
      batch_id: job.batchId,
      product_code: job.productCode,
      channel: job.channelId,
    });

    if (job.status !== "queued") {
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: `Post job in status ${job.status} cannot be cancelled`,
        userMessage: refusalMessage(job),
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          from: job.status,
          reason: job.status === "published" ? "ALREADY_PUBLISHED" : "NOT_QUEUED",
          published_post_id: job.publishedPostId,
        },
      });
      log.warn("Cancel refused", {
        err: appError,
        error_code: appError.code,
        job_status: job.status,
      });
      throw appError;
    }

    // --- 1. Database first --------------------------------------------------
    const actorUserId = await resolveActorUserId(deps, tenantId, input, log);
    const userMessage = "Bài đã được huỷ trước giờ đăng — không có gì được gửi lên kênh.";
    const next = transitionPostJob(job, "blocked", {
      reason: "OPERATOR_CANCELLED",
      errorCode: CANCELLED_ERROR_CODE,
      errorMessage: userMessage,
    });
    const note = sanitiseNote(input?.note);
    const cancelled = await deps.postJobs.applyTransition({
      tenantId,
      postJobId: job.id,
      from: "queued",
      next,
      reason: "OPERATOR_CANCELLED",
      actorUserId,
      auditAction: CANCELLED_AUDIT_ACTION,
      // "Vì sao bài này bị huỷ?" belongs in the trail, not only in a log line.
      auditPayload: {
        note,
        actor_email: str(input?.actorEmail).toLowerCase() || null,
        cancelled_scheduled_at: job.scheduledAt?.toISOString() ?? null,
      },
    });
    if (!cancelled) {
      // The race the brief cares about: the hour came while the operator was
      // clicking. Never pretend the cancel worked.
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: "Post job left `queued` before the cancel could be applied",
        userMessage:
          "Bài này vừa bắt đầu được đăng nên không huỷ được nữa — hãy tải lại để xem kết quả.",
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          from: "queued",
          reason: "CONCURRENT_MODIFICATION",
        },
      });
      log.warn("Cancel lost the race against the worker", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }

    // --- 2. Queue second ----------------------------------------------------
    const queueEntryRemoved = await removeEntry(deps, job, log);

    await deps.postJobs.refreshBatchStatus(tenantId, job.batchId);
    log.info("Scheduled post cancelled by an operator", {
      scheduled_at: job.scheduledAt?.toISOString() ?? null,
      queue_job_id: job.queueJobId,
      queue_entry_removed: queueEntryRemoved,
      actor_user_id: actorUserId,
      actor_email: str(input?.actorEmail) || null,
      note,
    });

    return {
      tenantId,
      postJobId: job.id,
      batchId: job.batchId,
      channelId: job.channelId,
      status: "blocked",
      scheduledAt: job.scheduledAt,
      queueEntryRemoved,
      userMessage,
    };
  };
}

export type CancelScheduledJob = ReturnType<typeof makeCancelScheduledJob>;

// --- helpers ----------------------------------------------------------------

function refusalMessage(job: PostJob): string {
  switch (job.status) {
    case "published":
      return "Bài này đã đăng lên kênh rồi — không huỷ được (hãy xoá trực tiếp trên kênh nếu cần).";
    case "publishing":
      return "Bài này đang được đăng — không huỷ được nữa.";
    case "blocked":
      return "Bài này đã bị dừng từ trước — không cần huỷ.";
    case "failed":
      return "Bài này đã dừng vì lỗi đăng — không cần huỷ.";
    default:
      return "Bài này chưa vào hàng đợi nên không có gì để huỷ.";
  }
}

/**
 * Drops the delayed entry. A failure is logged, never thrown: the row is already
 * `blocked`, so the worst case is a queue message that stops at the status guard.
 */
async function removeEntry(
  deps: CancelScheduledJobDeps,
  job: PostJob,
  log: Logger,
): Promise<boolean> {
  const queueJobId = str(job.queueJobId);
  if (queueJobId.length === 0) {
    log.warn("No queue id stored for this job — nothing to remove", {
      reason: "QUEUE_ID_MISSING",
    });
    return false;
  }
  try {
    const removed = await deps.queue.remove(queueJobId);
    if (!removed) {
      log.warn("Queue entry not found (already running or expired)", {
        reason: "ENTRY_NOT_REMOVED",
        queue_job_id: queueJobId,
      });
    }
    return removed;
  } catch (error) {
    log.error("Could not remove the queue entry of a cancelled post", {
      err: AppError.from(error, "QUEUE_ERROR", { tenant_id: job.tenantId, job_id: job.id }),
      error_code: "QUEUE_ERROR",
      queue_job_id: queueJobId,
      // Harmless (the status guard stops it) but it must not be invisible.
      alert: "OPERATOR_ATTENTION",
    });
    return false;
  }
}

/** Trimmed, collapsed and capped. Null when the operator wrote nothing. */
function sanitiseNote(raw: unknown): string | null {
  const note = str(raw).replace(/\s+/g, " ");
  if (note.length === 0) return null;
  return note.length > MAX_CANCEL_NOTE_LENGTH
    ? `${note.slice(0, MAX_CANCEL_NOTE_LENGTH)}…`
    : note;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
