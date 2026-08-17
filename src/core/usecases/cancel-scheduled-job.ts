import { AppError } from "@/core/domain/errors";
import { transitionPostJob, type PostJob } from "@/core/domain/post-job";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type {
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelPublisher,
} from "@/core/ports/publisher";
import type { UserRepo } from "@/core/ports/user-repo";

import { resolveActorUserId, type ActorInput } from "./resolve-actor";

/**
 * E8.4 — "huỷ" a post before it goes out.
 *
 * TWO cancellations, because there are two places a scheduled post can wait:
 *
 *   `queued`                 the QUEUE holds it -> database first, queue second.
 *   `scheduled_on_facebook`  FACEBOOK holds it  -> PLATFORM first, database
 *                            second (E8.6). The order is reversed on purpose:
 *                            marking the row cancelled and then failing to
 *                            delete the post would show "đã huỷ" on the screen
 *                            while Facebook publishes it at the hour anyway.
 *                            That is the single worst outcome of this feature,
 *                            so nothing is written until Facebook confirms the
 *                            post is gone.
 *
 * The job ends `blocked` with the error code OPERATOR_CANCELLED.
 * PENDING(E8-cancel-status): `blocked` is reused instead of adding a `cancelled`
 * state, because the state machine and the DB enum are shared with Phase 1 and a
 * new state costs a migration plus every exhaustive switch. `blocked` already
 * means "a rule said no, nothing was sent"; the code and the audit action carry
 * WHO said no. Proposal for the orchestrator: promote it to its own status when
 * the operator screens need to filter cancellations separately.
 *
 * Order for a `queued` job — database FIRST, queue second:
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
  /** E8.6 — true when the post was deleted on the platform by this cancel. */
  readonly platformPostDeleted: boolean;
  readonly userMessage: string;
}

export interface CancelScheduledJobDeps {
  postJobs: PostJobRepo;
  queue: JobQueue;
  logger: Logger;
  users?: UserRepo;
  /** E8.6 — needed to reach the Page that holds a handed-over post. */
  channels?: ChannelConfigRepo;
  publishers?: Partial<Record<ChannelPlatform, ChannelPublisher>>;
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

    if (job.status !== "queued" && job.status !== "scheduled_on_facebook") {
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

    const actorUserId = await resolveActorUserId(deps, tenantId, input, log);
    const handedOff = job.status === "scheduled_on_facebook";

    // --- 0. PLATFORM first, when the platform is the one holding the post ----
    // Nothing is written before Facebook confirms the post is gone: a row that
    // says "đã huỷ" next to a post Facebook still publishes is the worst
    // possible answer (see the header note).
    const platformPostDeleted = handedOff
      ? await deleteOnPlatform(deps, job, log)
      : false;

    // --- 1. Database ---------------------------------------------------------
    // Only reached when the platform CONFIRMED it no longer holds the post
    // (deleteOnPlatform throws on anything less), so this sentence is safe.
    const userMessage = !handedOff
      ? "Bài đã được huỷ trước giờ đăng — không có gì được gửi lên kênh."
      : platformPostDeleted
        ? "Đã gỡ bài đã hẹn khỏi Facebook và huỷ bài — Facebook sẽ không đăng nữa."
        : "Facebook báo không còn giữ bài này nữa — bài đã được huỷ trong hệ thống.";
    const next = transitionPostJob(job, "blocked", {
      reason: "OPERATOR_CANCELLED",
      errorCode: CANCELLED_ERROR_CODE,
      errorMessage: userMessage,
    });
    const note = sanitiseNote(input?.note);
    const cancelled = await deps.postJobs.applyTransition({
      tenantId,
      postJobId: job.id,
      from: job.status,
      next,
      reason: "OPERATOR_CANCELLED",
      actorUserId,
      auditAction: CANCELLED_AUDIT_ACTION,
      // "Vì sao bài này bị huỷ?" belongs in the trail, not only in a log line.
      auditPayload: {
        note,
        actor_email: str(input?.actorEmail).toLowerCase() || null,
        cancelled_scheduled_at: job.scheduledAt?.toISOString() ?? null,
        cancelled_from: job.status,
        platform_post_deleted: platformPostDeleted,
        scheduled_post_id: job.scheduledPostId,
      },
    });
    if (!cancelled) {
      // The race the brief cares about: the hour came while the operator was
      // clicking. Never pretend the cancel worked.
      const appError = new AppError("INVALID_JOB_TRANSITION", {
        message: `Post job left \`${job.status}\` before the cancel could be applied`,
        userMessage: platformPostDeleted
          ? "Bài đã được gỡ khỏi Facebook nhưng trạng thái trong hệ thống vừa thay đổi — hãy tải lại và kiểm tra Trang."
          : "Bài này vừa bắt đầu được đăng nên không huỷ được nữa — hãy tải lại để xem kết quả.",
        context: {
          tenant_id: tenantId,
          job_id: job.id,
          from: job.status,
          reason: "CONCURRENT_MODIFICATION",
          platform_post_deleted: platformPostDeleted,
        },
      });
      log[platformPostDeleted ? "error" : "warn"]("Cancel lost the race against the worker", {
        err: appError,
        error_code: appError.code,
        platform_post_deleted: platformPostDeleted,
        alert: "OPERATOR_ATTENTION",
      });
      throw appError;
    }

    // --- 2. Queue second ----------------------------------------------------
    // A handed-over post owns no queue entry any more (the transition to
    // `scheduled_on_facebook` cleared it), so there is nothing to remove.
    const queueEntryRemoved = handedOff ? false : await removeEntry(deps, job, log);

    await deps.postJobs.refreshBatchStatus(tenantId, job.batchId);
    log.info("Scheduled post cancelled by an operator", {
      cancelled_from: job.status,
      scheduled_at: job.scheduledAt?.toISOString() ?? null,
      queue_job_id: job.queueJobId,
      queue_entry_removed: queueEntryRemoved,
      scheduled_post_id: job.scheduledPostId,
      platform_post_deleted: platformPostDeleted,
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
      platformPostDeleted,
      userMessage,
    };
  };
}

export type CancelScheduledJob = ReturnType<typeof makeCancelScheduledJob>;

// --- helpers ----------------------------------------------------------------

/**
 * E8.6 — removes the post Facebook is holding, BEFORE anything is written.
 *
 * Every failure throws. There is no "best effort" here: the operator asked for
 * the post not to be published, and the only honest answers are "Facebook
 * confirmed it no longer holds it" or an error saying we do not know.
 *
 * "We do not know" is a REFUSAL, not a cancel. Graph answers a deleted post, a
 * token for the wrong Page and a missing permission with the same error, so a
 * failed read or a failed delete can never be turned into "Facebook sẽ không
 * đăng nữa" (see RemotePostState in core/ports/publisher).
 *
 * A post Facebook ALREADY published is refused instead of deleted: "huỷ trước
 * giờ đăng" must never silently delete a live post. The reconciliation sweep
 * moves that job to `published` with its real link.
 */
async function deleteOnPlatform(
  deps: CancelScheduledJobDeps,
  job: PostJob,
  log: Logger,
): Promise<boolean> {
  const postId = str(job.scheduledPostId);
  const refusal = (message: string, reason: string, userMessage: string): AppError => {
    const appError = new AppError("INVALID_JOB_TRANSITION", {
      message,
      userMessage,
      context: {
        tenant_id: job.tenantId,
        job_id: job.id,
        channel: job.channelId,
        scheduled_post_id: postId || null,
        from: job.status,
        reason,
      },
    });
    log.error("Cancel refused: cannot reach the post Facebook is holding", {
      err: appError,
      error_code: appError.code,
      reason,
      alert: "OPERATOR_ATTENTION",
    });
    return appError;
  };

  const onFacebook =
    "Bài này đã được giao cho Facebook giữ. Hệ thống chưa gỡ được nó, nên bài VẪN SẼ TỰ ĐĂNG — hãy vào Trang, mục bài đã lên lịch, để xoá thủ công.";

  if (postId.length === 0) {
    throw refusal("Scheduled job has no platform post id", "SCHEDULED_POST_ID_MISSING", onFacebook);
  }
  const channels = deps.channels;
  const publishers = deps.publishers;
  if (!channels || !publishers) {
    throw refusal(
      "Cancel is not wired to reach the platform",
      "PLATFORM_ACCESS_NOT_WIRED",
      onFacebook,
    );
  }

  const channel = await channels.findChannel(job.tenantId, job.channelId);
  if (!channel) {
    throw refusal(
      "Channel of a handed-over post no longer exists",
      "CHANNEL_MISSING",
      onFacebook,
    );
  }
  const scheduler = publishers[channel.platform]?.scheduled;
  if (!scheduler) {
    throw refusal("Platform has no scheduler to delete from", "SCHEDULER_NOT_WIRED", onFacebook);
  }

  // Already live? Then this is not a cancel, it is a deletion — refuse.
  let state;
  try {
    state = await scheduler.getPostState({ tenantId: job.tenantId, channel, postId });
  } catch (error) {
    // Token dead, rate limit, network: we could not even ASK. Refusing keeps the
    // row where it is; pretending would hide a post Facebook still publishes.
    throw platformFailure(job, log, error, postId, "PLATFORM_STATE_UNKNOWN", onFacebook, {
      operation: "cancelScheduledJob.getPostState",
    });
  }
  if (state.state === "published") {
    throw refusal(
      "The platform already published this post",
      "ALREADY_PUBLISHED_ON_PLATFORM",
      "Facebook đã đăng bài này rồi — không huỷ được nữa. Nếu cần gỡ, hãy xoá trực tiếp trên Trang.",
    );
  }
  if (state.state === "unknown") {
    // No verdict (unreadable answer, or Graph refusing to show the object). Not
    // a reason to stop: the DELETE below is the only thing that can settle it,
    // and it throws unless Facebook confirms the post is no longer scheduled.
    log.warn("The platform gave no readable state for this post — asking it to delete anyway", {
      reason: state.reason,
      scheduled_post_id: postId,
      alert: "OPERATOR_ATTENTION",
    });
  }

  let deleted: boolean;
  try {
    deleted = await scheduler.deleteScheduledPost({ tenantId: job.tenantId, channel, postId });
  } catch (error) {
    // THE dangerous branch: the operator asked to cancel, Facebook still holds
    // the post, and nothing in the row will change. The message must say so —
    // "hệ thống sẽ thử lại" (what the Graph error map would say for a 5xx or a
    // rate limit) is simply false here, nothing retries a cancel.
    throw platformFailure(job, log, error, postId, "PLATFORM_DELETE_FAILED", onFacebook, {
      operation: "cancelScheduledJob.deleteScheduledPost",
    });
  }
  log.info("Deleted the scheduled post on the platform", {
    scheduled_post_id: postId,
    deleted,
  });
  return deleted;
}

/**
 * Turns a platform failure during a cancel into an error whose Vietnamese
 * message tells the truth: the cancel did NOT happen, the post is still on
 * Facebook and will publish, and it has to be removed by hand.
 *
 * The platform's own `userMessage` is deliberately dropped: the Graph error map
 * writes it for the PUBLISH path ("hệ thống sẽ thử lại"), and repeating it here
 * would promise a retry that does not exist. The original code, message and
 * context stay in the log and in `cause`.
 */
function platformFailure(
  job: PostJob,
  log: Logger,
  error: unknown,
  postId: string,
  reason: string,
  userMessage: string,
  extraContext: Record<string, unknown>,
): AppError {
  const appError = AppError.from(error, "META_ERROR", {
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
    scheduled_post_id: postId || null,
    from: job.status,
    reason,
    ...extraContext,
  });
  log.error("Cancel failed: the post is still on Facebook and will publish", {
    err: appError,
    error_code: appError.code,
    reason,
    scheduled_post_id: postId || null,
    platform_post_deleted: false,
    alert: "OPERATOR_ATTENTION",
  });
  return new AppError(appError.code, {
    message: `Cancel could not remove the scheduled post (${reason}): ${appError.message}`,
    userMessage,
    context: appError.context,
    cause: appError,
  });
}

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
