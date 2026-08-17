import { AppError } from "@/core/domain/errors";
import {
  RETRYABLE_POST_JOB_STATUSES,
  canOperatorRetryPostJob,
  deferredPostJobQueueId,
  isRetryablePostJobStatus,
  transitionPostJob,
  unconfirmedPlatformPostReason,
  type PostJob,
  type PostJobStatus,
  type UnconfirmedPlatformPostReason,
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
 *
 * And one refusal the STATUS cannot express (E8.6): a `failed` job the platform
 * may already hold a post for — it carries the id of a scheduled object, or a
 * call ended without a verdict — is DUPLICATE_POST_BLOCKED. See the guard below
 * for the three ways a retry of such a row ends with two posts.
 *
 * BOTH questions are asked through `canOperatorRetryPostJob`, the same predicate
 * the job log draws its button with. The branches after it only pick the
 * sentence to show: a rule added to the domain can never light a button in front
 * of an API that refuses.
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

    // ONE question, asked through the same predicate the job log draws its
    // button with (canOperatorRetryPostJob): a rule added to it can never leave
    // a lit button in front of an API that refuses, nor the reverse. The
    // branches below only choose WHICH refusal to explain.
    if (canOperatorRetryPostJob(job)) {
      return await requeue(deps, job, input, log);
    }

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

    // --- The status is not enough (E8.6) ------------------------------------
    // The row is `failed`/`blocked` and the predicate still said no: the
    // platform may be holding a post for this exact job (it left an id behind,
    // or a call ended without a verdict). Re-queueing opens THREE roads to a
    // second post, and the status guard above sees none of them, because all
    // three start from a perfectly legal `queued`:
    //   pressed in T-30..T-12 -> hand_off  -> a SECOND scheduled post;
    //   pressed in T-12..T    -> wait      -> publish_now at T, live post next
    //                                         to the one Facebook holds;
    //   pressed after T       -> publish_now right away, same result.
    // So the refusal has to happen here, on the row, before anything is queued.
    // Recovery is a human one and the message says exactly what it is.
    //
    // The reason can be null here only if a FOURTH rule is added to
    // canOperatorRetryPostJob without a sentence in unconfirmedRefusalMessage.
    // That case is still REFUSED (with the generic sentence), never let through.
    const unconfirmedReason = unconfirmedPlatformPostReason(job);
    const appError = new AppError("DUPLICATE_POST_BLOCKED", {
      message: `Refusing to retry a job the platform may already hold a post for (${
        unconfirmedReason ?? "UNSPECIFIED"
      })`,
      userMessage: unconfirmedRefusalMessage(unconfirmedReason, job.scheduledPostId),
      context: {
        tenant_id: tenantId,
        job_id: job.id,
        batch_id: job.batchId,
        channel: job.channelId,
        from: job.status,
        last_error_code: job.lastErrorCode,
        scheduled_post_id: job.scheduledPostId,
        scheduled_at: job.scheduledAt?.toISOString() ?? null,
        reason: unconfirmedReason ?? "RETRY_REFUSED_BY_DOMAIN",
      },
    });
    log.warn("Retry refused: the platform may already hold a post for this job", {
      err: appError,
      error_code: appError.code,
      job_status: job.status,
      last_error_code: job.lastErrorCode,
      scheduled_post_id: job.scheduledPostId,
      refusal_reason: unconfirmedReason ?? "RETRY_REFUSED_BY_DOMAIN",
      user_message: appError.userMessage,
      alert: "OPERATOR_ATTENTION",
    });
    throw appError;
  };
}

export type RetryPostJob = ReturnType<typeof makeRetryPostJob>;

// --- the re-queue itself (only reached once the row passed the one guard) ----

async function requeue(
  deps: RetryPostJobDeps,
  job: PostJob,
  input: RetryPostJobInput,
  log: Logger,
): Promise<RetryPostJobResult> {
  const tenantId = job.tenantId;
  // --- Who is doing this? (audit trail) -------------------------------------
  const actorUserId = await resolveActorUserId(deps, tenantId, input, log);

  // --- Re-queue: DB first, queue second (a worker must see `queued`) ---------
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
}

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

/**
 * What an operator can actually DO about a row we refuse to re-run. One sentence
 * per reason, because the recovery differs: an id we hold can be deleted by
 * name, an unknown outcome has to be looked for first, and a job that died
 * mid-publish may have produced either a live post or a scheduled one.
 *
 * `null` is the fail-closed case: a refusal added to the domain predicate
 * without a sentence here still refuses, with the generic instruction.
 */
function unconfirmedRefusalMessage(
  reason: UnconfirmedPlatformPostReason | null,
  scheduledPostId: string | null,
): string {
  const idNote = typeof scheduledPostId === "string" && scheduledPostId.trim().length > 0
    ? ` (mã bài ${scheduledPostId.trim()})`
    : "";
  switch (reason) {
    case "PLATFORM_HOLDS_SCHEDULED_POST":
    case "SCHEDULE_UNCONFIRMED":
      return (
        `Facebook đã nhận lịch đăng của bài này${idNote} và hệ thống không xác nhận được kết quả — ` +
        "Trang CÓ THỂ vẫn đang giữ (hoặc đã đăng) bài đó. Chạy lại sẽ đăng trùng. " +
        "Hãy mở Trang, vào mục bài đã lên lịch, xoá bài nếu thấy, rồi soạn lại bài mới."
      );
    case "HANDOFF_OUTCOME_UNKNOWN":
      return (
        "Bài này đã được giao lịch cho Facebook nhưng hệ thống không nhận được xác nhận — " +
        "Trang CÓ THỂ đang giữ một bài hẹn của bài này. Chạy lại sẽ đăng trùng. " +
        "Hãy mở Trang, vào mục bài đã lên lịch, xoá bài nếu thấy, rồi soạn lại bài mới."
      );
    case "PUBLISH_OUTCOME_UNKNOWN":
      return (
        "Bài hẹn giờ này dừng giữa chừng khi đang gửi lên Facebook — Trang CÓ THỂ đã có bài " +
        "(đã đăng hoặc đang chờ tới giờ). Chạy lại sẽ đăng trùng. " +
        "Hãy mở Trang, xem cả bài đã đăng lẫn mục bài đã lên lịch, xoá bài nếu thấy, rồi soạn lại bài mới."
      );
    default:
      return (
        "Bài này có thể đã tồn tại trên Trang nên hệ thống không cho chạy lại để tránh đăng trùng — " +
        "hãy mở Trang kiểm tra (cả bài đã đăng lẫn mục bài đã lên lịch) rồi soạn lại bài mới."
      );
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
