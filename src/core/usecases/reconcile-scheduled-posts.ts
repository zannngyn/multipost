import { AppError } from "@/core/domain/errors";
import { transitionPostJob, type PostJob, type TransitionMeta } from "@/core/domain/post-job";
import type { Clock, Logger } from "@/core/ports/infra";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type {
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelPublisher,
  RemotePostState,
} from "@/core/ports/publisher";

/**
 * E8.6 — the sweep that closes the loop on a handed-over post.
 *
 * Facebook publishes a scheduled post at its hour and tells nobody. Without
 * this job every handed-over post would sit in `scheduled_on_facebook` forever:
 * live on the Page, "đang chờ" on our screens, no link to show.
 *
 * It ASKS Graph and believes only a yes:
 *   is_published = true   -> `published`, with Facebook's own permalink
 *   is_published = false  -> still waiting (Meta publishes a minute or two late)
 *   anything unreadable   -> left alone and logged; after `giveUpMs` the job is
 *                            marked `failed` with an instruction to check the
 *                            Page, because a post nobody can account for must
 *                            not stay invisible (business rule 5).
 *
 * There is deliberately no "the post was deleted on the Page" verdict. Graph
 * answers a deleted post, a token for the wrong Page and a missing permission
 * with the SAME error, so the platform reports `unknown` (see RemotePostState)
 * and this sweep treats it as what it is: no answer yet. Quietly marking such a
 * job `blocked` would tell the operator "bài sẽ không lên" while Facebook goes
 * on to publish it.
 *
 * It NEVER publishes anything: the post either exists on the platform or it
 * does not, and re-sending it is the duplicate this whole design avoids.
 *
 * Shaped like the reaper (core/usecases/reap-post-jobs): a cross-tenant scan, a
 * bounded batch per tick, one bad row never ends the sweep.
 */

export const RECONCILE_SCHEDULED_POSTS_JOB_NAME = "reconcile-scheduled-posts";

/** Audit actions that name the EVENT, not just the resulting status. */
export const RECONCILED_PUBLISHED_AUDIT_ACTION = "post_job.published_by_platform";
export const RECONCILED_UNCONFIRMED_AUDIT_ACTION = "post_job.schedule_unconfirmed";

/** Error code stored on the row (free text by contract, see PostJob). */
export const SCHEDULE_UNCONFIRMED_ERROR_CODE = "SCHEDULE_UNCONFIRMED";

/**
 * How long after the hour to start asking. Meta does not publish at the second,
 * and a question asked too early only produces `is_published=false` noise.
 */
export const DEFAULT_RECONCILE_GRACE_MS = 3 * 60 * 1000;

/**
 * How long a post may stay unconfirmed before it is called `failed`. Deliberately
 * long: the answer "Facebook has not published it yet" is normal for minutes,
 * and a false alarm that makes an operator re-post is worse than a late one.
 */
export const DEFAULT_RECONCILE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RECONCILE_LIMIT = 50;

export interface ReconcileScheduledPostsInput {
  readonly graceMs?: number;
  readonly giveUpMs?: number;
  readonly limit?: number;
}

export interface ReconciledJob {
  readonly postJobId: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly channelId: string;
  /**
   * No `blocked`: this sweep never declares a post dead. Only Facebook saying
   * "published" settles a job here; everything else waits or, past the horizon,
   * becomes `failed` with "hãy mở Trang kiểm tra".
   */
  readonly outcome: "published" | "waiting" | "failed" | "skipped";
  readonly reason: string;
}

export interface ReconcileScheduledPostsResult {
  readonly scanned: number;
  readonly published: number;
  readonly waiting: number;
  readonly failed: number;
  readonly skipped: number;
  readonly jobs: readonly ReconciledJob[];
  readonly durationMs: number;
}

export interface ReconcileScheduledPostsDeps {
  postJobs: PostJobRepo;
  channels: ChannelConfigRepo;
  /** Same map publish-post uses: the CHANNEL decides which API answers. */
  publishers: Partial<Record<ChannelPlatform, ChannelPublisher>>;
  clock: Clock;
  logger: Logger;
}

export function makeReconcileScheduledPosts(deps: ReconcileScheduledPostsDeps) {
  return async function reconcileScheduledPosts(
    input: ReconcileScheduledPostsInput = {},
  ): Promise<ReconcileScheduledPostsResult> {
    // --- Edge cases first ---------------------------------------------------
    const graceMs = positiveInt(input?.graceMs) ?? DEFAULT_RECONCILE_GRACE_MS;
    const giveUpMs = positiveInt(input?.giveUpMs) ?? DEFAULT_RECONCILE_GIVE_UP_MS;
    const limit = positiveInt(input?.limit) ?? DEFAULT_RECONCILE_LIMIT;

    const startedMs = deps.clock.nowMs();
    const log = deps.logger.child({ component: "scheduled-post-reconciler" });

    const due = await deps.postJobs.findScheduledOnPlatformDue({
      dueBefore: new Date(startedMs - graceMs),
      limit,
    });

    const jobs: ReconciledJob[] = [];
    for (const job of due) {
      jobs.push(await reconcileOne(deps, job, log, { giveUpMs, nowMs: startedMs }));
    }

    const result: ReconcileScheduledPostsResult = {
      scanned: due.length,
      published: jobs.filter((entry) => entry.outcome === "published").length,
      waiting: jobs.filter((entry) => entry.outcome === "waiting").length,
      failed: jobs.filter((entry) => entry.outcome === "failed").length,
      skipped: jobs.filter((entry) => entry.outcome === "skipped").length,
      jobs,
      durationMs: deps.clock.nowMs() - startedMs,
    };

    // Always logged, quiet runs included: it is the line that proves the sweep
    // still runs at all.
    log.info("Scheduled post reconciliation finished", {
      ...result,
      jobs: undefined,
      grace_ms: graceMs,
      give_up_ms: giveUpMs,
      limit,
      ...(result.failed > 0 ? { alert: "OPERATOR_ATTENTION" } : {}),
    });
    return result;
  };
}

export type ReconcileScheduledPosts = ReturnType<typeof makeReconcileScheduledPosts>;

// --- one job -----------------------------------------------------------------

async function reconcileOne(
  deps: ReconcileScheduledPostsDeps,
  job: PostJob,
  parentLog: Logger,
  ctx: { giveUpMs: number; nowMs: number },
): Promise<ReconciledJob> {
  const log = parentLog.child({
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
    scheduled_post_id: job.scheduledPostId,
    scheduled_at: job.scheduledAt?.toISOString() ?? null,
  });

  try {
    // --- Edge cases first ---------------------------------------------------
    const postId = str(job.scheduledPostId);
    if (postId.length === 0) {
      // Impossible through transitionPostJob; a hand-edited row would otherwise
      // wait forever for an answer nobody can ask for.
      return await giveUp(deps, job, log, "NO_SCHEDULED_POST_ID");
    }

    const channel = await deps.channels.findChannel(job.tenantId, job.channelId);
    if (!channel) {
      log.error("Cannot reconcile: the channel of this post no longer exists", {
        reason: "CHANNEL_MISSING",
        alert: "OPERATOR_ATTENTION",
      });
      return await giveUpIfTooOld(deps, job, log, ctx, "CHANNEL_MISSING");
    }

    const scheduler = deps.publishers[channel.platform]?.scheduled;
    if (!scheduler) {
      log.error("Cannot reconcile: this platform has no scheduler wired", {
        reason: "SCHEDULER_NOT_WIRED",
        platform: channel.platform,
        alert: "OPERATOR_ATTENTION",
      });
      return reconciled(job, "skipped", "SCHEDULER_NOT_WIRED");
    }

    let state: RemotePostState;
    try {
      state = await scheduler.getPostState({
        tenantId: job.tenantId,
        channel,
        postId,
      });
    } catch (error) {
      // Token, rate limit, transport: the platform could not answer THIS time.
      // Never a verdict on the post — the next sweep asks again.
      const appError = AppError.from(error, "META_ERROR", {
        tenant_id: job.tenantId,
        job_id: job.id,
        channel: job.channelId,
        operation: "reconcileScheduledPosts.getPostState",
      });
      log.error("Could not ask the platform about a scheduled post", {
        err: appError,
        error_code: appError.code,
        alert: "OPERATOR_ATTENTION",
      });
      return await giveUpIfTooOld(deps, job, log, ctx, `ASK_FAILED:${appError.code}`);
    }

    if (state.state === "published") {
      const done = await move(
        deps,
        job,
        "published",
        {
          reason: "PUBLISHED_BY_PLATFORM",
          publishedPostId: state.postId,
          publishedUrl: state.url,
          publishedAt: state.publishedAt ?? deps.clock.now(),
        },
        RECONCILED_PUBLISHED_AUDIT_ACTION,
      );
      if (!done) {
        log.info("Scheduled post moved on by itself during the sweep — left alone", {
          reason: "ROW_CHANGED_DURING_SWEEP",
        });
        return reconciled(job, "skipped", "ROW_CHANGED_DURING_SWEEP");
      }
      await refreshBatch(deps, job, log);
      log.info("Facebook published a scheduled post — job closed", {
        outcome: "published",
        published_post_id: done.publishedPostId,
        published_url: done.publishedUrl,
        published_at: done.publishedAt?.toISOString() ?? null,
        audit_action: RECONCILED_PUBLISHED_AUDIT_ACTION,
      });
      return reconciled(job, "published", "PUBLISHED_BY_PLATFORM");
    }

    if (state.state === "scheduled") {
      // Normal for the first minutes after the hour.
      log.info("Facebook has not published this post yet — waiting", {
        outcome: "waiting",
        platform_publish_at: state.publishAt?.toISOString() ?? null,
      });
      return await giveUpIfTooOld(deps, job, log, ctx, "STILL_SCHEDULED");
    }

    log.warn("The platform gave no readable state for this post", {
      outcome: "waiting",
      reason: state.reason,
      alert: "OPERATOR_ATTENTION",
    });
    return await giveUpIfTooOld(deps, job, log, ctx, `UNKNOWN_STATE:${state.reason}`);
  } catch (error) {
    // One bad row must not end the sweep; the next tick tries again.
    log.error("Could not reconcile a scheduled post", {
      err: AppError.from(error, "INTERNAL", { tenant_id: job.tenantId, job_id: job.id }),
      reason: "RECONCILE_FAILED",
      alert: "OPERATOR_ATTENTION",
    });
    return reconciled(job, "skipped", "RECONCILE_FAILED");
  }
}

/**
 * Past the give-up horizon a post nobody can account for becomes `failed`, with
 * the same instruction the reaper gives: CHECK THE PAGE before running it again.
 * Anything else would either hide a live post or invite a duplicate.
 */
async function giveUpIfTooOld(
  deps: ReconcileScheduledPostsDeps,
  job: PostJob,
  log: Logger,
  ctx: { giveUpMs: number; nowMs: number },
  reason: string,
): Promise<ReconciledJob> {
  const scheduledMs = job.scheduledAt instanceof Date ? job.scheduledAt.getTime() : null;
  const tooOld = scheduledMs !== null && ctx.nowMs - scheduledMs > ctx.giveUpMs;
  if (!tooOld) return reconciled(job, "waiting", reason);
  return await giveUp(deps, job, log, reason);
}

async function giveUp(
  deps: ReconcileScheduledPostsDeps,
  job: PostJob,
  log: Logger,
  reason: string,
): Promise<ReconciledJob> {
  const userMessage =
    "Không xác nhận được bài đã hẹn trên Facebook sau nhiều lần kiểm tra — hãy mở Trang để xem bài đã lên chưa rồi mới bấm Chạy lại.";
  const failed = await move(
    deps,
    job,
    "failed",
    {
      reason,
      errorCode: SCHEDULE_UNCONFIRMED_ERROR_CODE,
      errorMessage: userMessage,
    },
    RECONCILED_UNCONFIRMED_AUDIT_ACTION,
  );
  if (!failed) return reconciled(job, "skipped", "ROW_CHANGED_DURING_SWEEP");
  await refreshBatch(deps, job, log);
  log.error("Gave up confirming a scheduled post — marked failed, NOT republished", {
    outcome: "failed",
    error_code: SCHEDULE_UNCONFIRMED_ERROR_CODE,
    reason,
    audit_action: RECONCILED_UNCONFIRMED_AUDIT_ACTION,
    alert: "OPERATOR_ATTENTION",
  });
  return reconciled(job, "failed", reason);
}

// --- helpers ----------------------------------------------------------------

async function move(
  deps: ReconcileScheduledPostsDeps,
  job: PostJob,
  to: "published" | "failed",
  meta: TransitionMeta & { reason: string },
  auditAction: string,
): Promise<PostJob | null> {
  const next = transitionPostJob(job, to, meta);
  return deps.postJobs.applyTransition({
    tenantId: job.tenantId,
    postJobId: job.id,
    from: job.status,
    next,
    reason: meta.reason,
    auditAction,
    auditPayload: {
      scheduled_post_id: job.scheduledPostId,
      scheduled_at: job.scheduledAt?.toISOString() ?? null,
    },
  });
}

async function refreshBatch(
  deps: ReconcileScheduledPostsDeps,
  job: PostJob,
  log: Logger,
): Promise<void> {
  await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId).catch((error: unknown) => {
    // The batch summary is a cached read model: failing to refresh it must not
    // undo the reconciliation, but it must not be silent either.
    log.warn("Could not refresh the batch summary after reconciling", {
      err: AppError.from(error, "DB_ERROR", { tenant_id: job.tenantId, batch_id: job.batchId }),
    });
  });
}

function reconciled(
  job: PostJob,
  outcome: ReconciledJob["outcome"],
  reason: string,
): ReconciledJob {
  return {
    postJobId: job.id,
    tenantId: job.tenantId,
    batchId: job.batchId,
    channelId: job.channelId,
    outcome,
    reason,
  };
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
