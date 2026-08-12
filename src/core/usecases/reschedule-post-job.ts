import { AppError } from "@/core/domain/errors";
import {
  deferredPostJobQueueId,
  evaluateScheduledAt,
  scheduleRejectionMessage,
  type PostJob,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";
import type { UserRepo } from "@/core/ports/user-repo";

import { PUBLISH_POST_JOB_NAME } from "./publish-post";
import { resolveActorUserId, type ActorInput } from "./resolve-actor";

/**
 * E8.4 — "đổi giờ" a post that has not gone out yet.
 *
 * Only a `queued` job whose time is still ahead can move: once the hour comes a
 * worker may already be claiming it, and rewriting the schedule of a post that
 * is being published would leave the row lying about when it went live.
 *
 * Order (the whole point of this file):
 *   1. validate the new time (future, within the window)
 *   2. WRITE the new schedule + new queue id first (optimistic, WHERE queued)
 *   3. enqueue the new delayed job
 *   4. remove the OLD queue entry LAST
 *
 * Step 4 comes last on purpose. If it fails, the worst case is a duplicate
 * queue message — and a duplicate is harmless here: the second one finds the row
 * no longer `queued` (or already `published`) and stops at the status guard of
 * publish-post. Removing first and crashing before step 3 would instead leave a
 * post that never publishes, which nothing recovers.
 */

export interface ReschedulePostJobInput extends ActorInput {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly newScheduledAt: Date | string;
}

export interface ReschedulePostJobResult {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly channelId: string;
  readonly batchId: string;
  readonly previousScheduledAt: Date | null;
  readonly scheduledAt: Date;
  readonly delayMs: number;
  readonly queueJobId: string;
  /** False when the old delayed entry could not be dropped (see the note above). */
  readonly previousQueueEntryRemoved: boolean;
  readonly userMessage: string;
}

export interface ReschedulePostJobDeps {
  postJobs: PostJobRepo;
  channels: ChannelConfigRepo;
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  users?: UserRepo;
}

export function makeReschedulePostJob(deps: ReschedulePostJobDeps) {
  return async function reschedulePostJob(
    input: ReschedulePostJobInput,
  ): Promise<ReschedulePostJobResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = str(input?.tenantId);
    const postJobId = str(input?.postJobId);
    if (!isTenantId(tenantId) || postJobId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "reschedulePostJob requires a tenant UUID and a post job id",
        userMessage: "Yêu cầu đổi giờ đăng thiếu thông tin định danh.",
        context: { tenant_id: tenantId || null, post_job_id: postJobId || null },
      });
    }

    const nowMs = deps.clock.nowMs();
    const verdict = evaluateScheduledAt(input?.newScheduledAt, nowMs);
    if (!verdict.ok) {
      throw new AppError("INVALID_INPUT", {
        message: `New schedule rejected: ${verdict.reason}`,
        userMessage: scheduleRejectionMessage(verdict.reason),
        context: {
          tenant_id: tenantId,
          job_id: postJobId,
          field: "newScheduledAt",
          reason: verdict.reason,
          requested: verdict.at?.toISOString() ?? null,
        },
      });
    }

    const job = await deps.postJobs.findJobById(tenantId, postJobId);
    if (!job) {
      throw new AppError("INVALID_INPUT", {
        message: "Post job not found",
        userMessage: "Không tìm thấy bài đăng cần đổi giờ.",
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

    assertReschedulable(job, nowMs, log);

    // --- 2. DB first --------------------------------------------------------
    const actorUserId = await resolveActorUserId(deps, tenantId, input, log);
    // A NEW queue id: BullMQ ignores an `add` whose id is still retained, and
    // the old id is exactly the one still sitting in the delayed set.
    const queueJobId = deferredPostJobQueueId(job, nowMs);
    const updated = await deps.postJobs.rescheduleJob({
      tenantId,
      postJobId: job.id,
      scheduledAt: verdict.at,
      queueJobId,
      previousScheduledAt: job.scheduledAt,
      previousQueueJobId: job.queueJobId,
      actorUserId,
      reason: "OPERATOR_RESCHEDULED",
    });
    if (!updated) {
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: "Post job left `queued` before the reschedule could be applied",
        userMessage: "Bài này vừa được xử lý ở nơi khác — hãy tải lại rồi thử lại.",
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          from: job.status,
          reason: "CONCURRENT_MODIFICATION",
        },
      });
      log.warn("Reschedule lost the race for this job", { err: appError, error_code: appError.code });
      throw appError;
    }

    // --- 3. New queue entry -------------------------------------------------
    const settings = await deps.channels.getPublishSettings(tenantId);
    try {
      await deps.queue.enqueue(
        PUBLISH_POST_JOB_NAME,
        { tenantId, postJobId: job.id },
        {
          jobId: queueJobId,
          delayMs: verdict.delayMs,
          attempts: settings.maxAttempts,
          backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
        },
      );
    } catch (error) {
      // The row now says "publish later" but nothing will fire. Say it loudly:
      // the old entry (if any) still exists, so the post may go out at the OLD
      // time — an operator has to look.
      const appError = AppError.from(error, "QUEUE_ERROR", {
        tenant_id: tenantId,
        job_id: job.id,
        channel: job.channelId,
        operation: "reschedulePostJob.enqueue",
        old_queue_job_id: job.queueJobId,
        new_scheduled_at: verdict.at.toISOString(),
      });
      log.error("Reschedule stored but the new queue entry failed", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }

    // --- 4. Drop the old entry (best effort, see the header note) ------------
    const previousQueueEntryRemoved = await removeOldEntry(deps, job, log);

    const userMessage = `Đã đổi giờ đăng sang ${verdict.at.toISOString()}. Tồn kho vẫn được kiểm tra lại ngay trước khi đăng.`;
    log.info("Scheduled post rescheduled", {
      previous_scheduled_at: job.scheduledAt?.toISOString() ?? null,
      scheduled_at: verdict.at.toISOString(),
      delay_ms: verdict.delayMs,
      previous_queue_job_id: job.queueJobId,
      queue_job_id: queueJobId,
      previous_queue_entry_removed: previousQueueEntryRemoved,
      actor_user_id: actorUserId,
      actor_email: str(input?.actorEmail) || null,
    });

    return {
      tenantId,
      postJobId: job.id,
      channelId: job.channelId,
      batchId: job.batchId,
      previousScheduledAt: job.scheduledAt,
      scheduledAt: verdict.at,
      delayMs: verdict.delayMs,
      queueJobId,
      previousQueueEntryRemoved,
      userMessage,
    };
  };
}

export type ReschedulePostJob = ReturnType<typeof makeReschedulePostJob>;

// --- helpers ----------------------------------------------------------------

/** Throws unless the job is queued AND still waiting for a future time. */
function assertReschedulable(job: PostJob, nowMs: number, log: Logger): void {
  if (job.status !== "queued") {
    const appError = new AppError("INVALID_JOB_TRANSITION", {
      message: `Post job in status ${job.status} cannot be rescheduled`,
      userMessage:
        job.status === "published"
          ? "Bài này đã đăng rồi — không đổi giờ được."
          : `Bài đang ở trạng thái "${job.status}" nên không đổi giờ được.`,
      context: {
        tenant_id: job.tenantId,
        job_id: job.id,
        from: job.status,
        reason: "NOT_QUEUED",
        published_post_id: job.publishedPostId,
      },
    });
    log.warn("Reschedule refused", { err: appError, error_code: appError.code, job_status: job.status });
    throw appError;
  }

  if (!(job.scheduledAt instanceof Date)) {
    // An immediate post has no hour to move; it is already on its way.
    const appError = new AppError("INVALID_INPUT", {
      message: "Post job has no scheduled time",
      userMessage: "Bài này đăng ngay, không phải bài hẹn giờ — không có giờ để đổi.",
      context: { tenant_id: job.tenantId, job_id: job.id, reason: "NOT_SCHEDULED" },
    });
    log.warn("Reschedule refused", { err: appError, error_code: appError.code });
    throw appError;
  }

  if (job.scheduledAt.getTime() <= nowMs) {
    const appError = new AppError("INVALID_JOB_TRANSITION", {
      message: "The scheduled time has already passed",
      userMessage:
        "Đã đến giờ đăng của bài này — không đổi giờ được nữa. Hãy huỷ hoặc chờ kết quả.",
      context: {
        tenant_id: job.tenantId,
        job_id: job.id,
        scheduled_at: job.scheduledAt.toISOString(),
        reason: "SCHEDULE_ALREADY_DUE",
      },
    });
    log.warn("Reschedule refused", { err: appError, error_code: appError.code });
    throw appError;
  }
}

/**
 * Removes the previous delayed entry. A failure here is logged and swallowed on
 * purpose: the new schedule is already stored and enqueued, and the stale entry
 * is harmless (publish-post's status guard stops it) — but it must be visible.
 */
async function removeOldEntry(
  deps: ReschedulePostJobDeps,
  job: PostJob,
  log: Logger,
): Promise<boolean> {
  const oldId = str(job.queueJobId);
  if (oldId.length === 0) {
    log.warn("No previous queue id stored — could not drop the old entry", {
      reason: "QUEUE_ID_MISSING",
    });
    return false;
  }
  try {
    const removed = await deps.queue.remove(oldId);
    if (!removed) {
      log.warn("Old queue entry was not found (already running or expired)", {
        reason: "OLD_ENTRY_NOT_REMOVED",
        old_queue_job_id: oldId,
      });
    }
    return removed;
  } catch (error) {
    log.error("Could not remove the old queue entry; it may still fire at the old time", {
      err: AppError.from(error, "QUEUE_ERROR", { tenant_id: job.tenantId, job_id: job.id }),
      error_code: "QUEUE_ERROR",
      old_queue_job_id: oldId,
      alert: "OPERATOR_ATTENTION",
    });
    return false;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
