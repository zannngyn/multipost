import { AppError } from "@/core/domain/errors";
import {
  RETRYABLE_POST_JOB_STATUSES,
  deferredPostJobQueueId,
  isRetryablePostJobStatus,
  transitionPostJob,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";
import type { UserRepo } from "@/core/ports/user-repo";

import { PUBLISH_POST_JOB_NAME } from "./publish-post";
import { resolveActorUserId } from "./resolve-actor";

/**
 * E11.1 — an operator presses "chạy lại" on ONE post job.
 *
 * It only re-queues: every gate stays where it belongs, in publish-post. A job
 * blocked by OUT_OF_STOCK therefore goes through the stock recheck again and
 * gets blocked again if the code is still sold out — retrying must never be a
 * way around business rule 3.
 *
 * Only `failed` and `blocked` can be retried (the transition table allows
 * exactly those two -> queued):
 *   published  -> INVALID_JOB_TRANSITION. A second publish is the worst bug this
 *                 tool can have; there is no "force" flag on purpose.
 *   queued     -> INVALID_JOB_TRANSITION. It is already waiting; a second queue
 *                 entry would be a second publish attempt of the same row.
 *   publishing -> INVALID_JOB_TRANSITION. Another worker owns it (or a crashed
 *                 run does) and we cannot know whether the platform got the post.
 *   draft      -> INVALID_JOB_TRANSITION. Nothing failed yet; the batch flow
 *                 owns the first enqueue.
 */

export interface RetryPostJobInput {
  readonly tenantId: string;
  readonly postJobId: string;
  /** Operator id for the audit trail; null for an automated retry. */
  readonly actorUserId?: string | null;
  /**
   * Operator e-mail from the session. Resolved to an app_user id when a
   * `users` repo is wired; `actorUserId` always wins when both are given.
   */
  readonly actorEmail?: string | null;
}

export interface RetryPostJobResult {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly batchId: string;
  readonly channelId: string;
  readonly productCode: string;
  /** Status before the retry — what the operator was looking at. */
  readonly previousStatus: PostJobStatus;
  readonly status: PostJobStatus;
  readonly queueJobId: string;
  readonly attemptCount: number;
  readonly userMessage: string;
}

export interface RetryPostJobDeps {
  postJobs: PostJobRepo;
  channels: ChannelConfigRepo;
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  /**
   * Optional: resolves the session e-mail to an app_user id for the audit row.
   * Optional and not required so the usecase keeps working (attributing the
   * action to nobody, with a warning) wherever it is not wired yet — a retry
   * must never fail because we could not name the operator.
   */
  users?: UserRepo;
}

export function makeRetryPostJob(deps: RetryPostJobDeps) {
  return async function retryPostJob(input: RetryPostJobInput): Promise<RetryPostJobResult> {
    // --- Edge cases first ---------------------------------------------------
    const tenantId = str(input?.tenantId);
    const postJobId = str(input?.postJobId);
    if (!isTenantId(tenantId) || postJobId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "retryPostJob requires a tenant UUID and a post job id",
        userMessage: "Yêu cầu chạy lại bài đăng thiếu thông tin định danh.",
        context: { tenant_id: tenantId || null, post_job_id: postJobId || null },
      });
    }

    const job = await deps.postJobs.findJobById(tenantId, postJobId);
    if (!job) {
      throw new AppError("INVALID_INPUT", {
        message: "Post job not found",
        userMessage: "Không tìm thấy bài đăng cần chạy lại.",
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

    if (!isRetryablePostJobStatus(job.status)) {
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: `Post job in status ${job.status} cannot be retried`,
        userMessage: retryRefusalMessage(job.status),
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          batch_id: job.batchId,
          channel: job.channelId,
          from: job.status,
          allowed_from: RETRYABLE_POST_JOB_STATUSES,
          published_post_id: job.publishedPostId,
          reason: job.status === "published" ? "ALREADY_PUBLISHED" : "NOT_IN_A_RETRYABLE_STATE",
        },
      });
      log.warn("Retry refused", {
        err: appError,
        error_code: appError.code,
        job_status: job.status,
        user_message: appError.userMessage,
      });
      throw appError;
    }

    // --- Who is doing this? (audit trail) -----------------------------------
    const actorUserId = await resolveActorUserId(deps, tenantId, input, log);

    // --- Re-queue: DB first, queue second (a worker must see `queued`) -------
    // A NEW queue id every time: BullMQ ignores an `add` whose id is still in
    // the retained set. It is stored IN the transition, so the stale-entry guard
    // in publish-post recognises the entry this retry is about to create.
    const queueJobId = deferredPostJobQueueId(job, deps.clock.nowMs());
    const next = transitionPostJob(job, "queued", { reason: "OPERATOR_RETRY", queueJobId });
    const queued = await deps.postJobs.applyTransition({
      tenantId,
      postJobId: job.id,
      from: job.status,
      next,
      reason: "OPERATOR_RETRY",
      actorUserId,
    });
    if (!queued) {
      // Somebody else moved the row between the read and the write (a second
      // click, another operator, a worker). Refuse instead of double-queueing.
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: "Post job status changed before the retry could be applied",
        userMessage: "Bài này vừa được xử lý ở nơi khác — hãy tải lại rồi thử lại.",
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          from: job.status,
          reason: "CONCURRENT_MODIFICATION",
        },
      });
      log.warn("Retry lost the race for this job", { err: appError, error_code: appError.code });
      throw appError;
    }

    const settings = await deps.channels.getPublishSettings(tenantId);

    try {
      await deps.queue.enqueue(
        PUBLISH_POST_JOB_NAME,
        { tenantId, postJobId: queued.id },
        {
          jobId: queueJobId,
          attempts: settings.maxAttempts,
          backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
        },
      );
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        tenant_id: tenantId,
        job_id: queued.id,
        batch_id: queued.batchId,
        channel: queued.channelId,
        operation: "retryPostJob.enqueue",
      });
      // Put the row back where it was: a `queued` job nobody will ever pick up
      // is the silent failure this whole file exists to avoid.
      const userMessage = "Không đưa được bài vào hàng đợi — bài vẫn ở trạng thái lỗi, hãy thử lại.";
      await revert(deps, queued, job.status, appError.code, userMessage);
      log.error("Retry could not enqueue the job", {
        err: appError,
        error_code: appError.code,
        reverted_to: job.status,
      });
      throw appError;
    }

    await deps.postJobs.refreshBatchStatus(tenantId, queued.batchId);

    const userMessage = "Đã đưa bài vào hàng đợi để đăng lại — tồn kho sẽ được kiểm tra lại trước khi đăng.";
    log.info("Post job re-queued by an operator", {
      previous_status: job.status,
      previous_error_code: job.lastErrorCode,
      queue_job_id: queueJobId,
      attempts: settings.maxAttempts,
      attempt_count: queued.attemptCount,
      actor_user_id: actorUserId,
      actor_email: str(input?.actorEmail) || null,
    });

    return {
      tenantId,
      postJobId: queued.id,
      batchId: queued.batchId,
      channelId: queued.channelId,
      productCode: queued.productCode,
      previousStatus: job.status,
      status: queued.status,
      queueJobId,
      attemptCount: queued.attemptCount,
      userMessage,
    };
  };
}

export type RetryPostJob = ReturnType<typeof makeRetryPostJob>;

// --- helpers ----------------------------------------------------------------

/**
 * Best-effort rollback after a failed enqueue. Its own failure is logged and
 * swallowed *deliberately* — never silently: the caller already throws
 * QUEUE_ERROR, and hiding that behind a DB error would lose the real cause.
 */
async function revert(
  deps: RetryPostJobDeps,
  job: PostJob,
  to: PostJobStatus,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  try {
    const reverted = transitionPostJob(job, to, {
      reason: "RETRY_ENQUEUE_FAILED",
      errorCode,
      errorMessage,
    });
    await deps.postJobs.applyTransition({
      tenantId: job.tenantId,
      postJobId: job.id,
      from: job.status,
      next: reverted,
      reason: "RETRY_ENQUEUE_FAILED",
    });
  } catch (error) {
    deps.logger.error("Could not revert a post job after a failed retry enqueue", {
      err: AppError.from(error, "DB_ERROR", {
        tenant_id: job.tenantId,
        job_id: job.id,
        from: job.status,
        to,
      }),
      error_code: "DB_ERROR",
      alert: "OPERATOR_ATTENTION",
    });
  }
}

function retryRefusalMessage(status: PostJobStatus): string {
  switch (status) {
    case "published":
      return "Bài này đã đăng thành công rồi — không chạy lại để tránh đăng trùng.";
    case "publishing":
      return "Bài này đang được đăng — chờ xử lý xong rồi mới chạy lại được.";
    case "queued":
      return "Bài này đang nằm trong hàng đợi — không cần chạy lại.";
    case "draft":
      return "Bài này chưa từng được đưa vào hàng đợi — hãy đăng lại từ màn soạn bài.";
    default:
      return "Trạng thái hiện tại của bài không cho phép chạy lại.";
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
