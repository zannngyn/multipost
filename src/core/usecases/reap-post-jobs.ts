import { AppError } from "@/core/domain/errors";
import {
  deferredPostJobQueueId,
  HANDOFF_WINDOW_START_MS,
  transitionPostJob,
  type PostJob,
} from "@/core/domain/post-job";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";

import { PUBLISH_POST_JOB_NAME } from "./publish-post";

/**
 * The reaper — a periodic sweep for the two ways a post can go quiet forever.
 * Both were accepted risks until now; nothing else in the system notices them.
 *
 *   a) STUCK IN `publishing`: a worker died between the claim and the answer.
 *      The row is claimed, so no retry, no timeout and no operator screen will
 *      ever move it. The reaper marks it `failed` — it does NOT republish:
 *      whether Facebook got the post is unknowable from here, and a second
 *      publish is the worst bug this tool can have (business rule 4). A human
 *      presses "Chạy lại" after checking the Page; that retry goes through the
 *      stock recheck like any other.
 *
 *   b) OVERDUE `queued` WITH NO QUEUE ENTRY: the schedule passed but Redis has
 *      nothing to fire — a lost/evicted entry, a failed reschedule cleanup, a
 *      flushed broker. Here re-enqueueing IS safe: the job never entered
 *      `publishing`, so nothing was sent, and publish-post runs every gate
 *      again (stock recheck included).
 *
 * Everything goes through the optimistic transitions, so a worker that picks a
 * row up in the same second wins and the reaper simply skips it.
 */

export const REAP_POST_JOBS_JOB_NAME = "post-job-reaper";

/** Audit actions that name what the SYSTEM did, not just the resulting status. */
export const REAPER_FAILED_AUDIT_ACTION = "post_job.failed_stale_publishing";
export const REAPER_REQUEUED_AUDIT_ACTION = "post_job.requeued_by_reaper";

/** A worker that has not touched a `publishing` row in 15' is not coming back. */
export const DEFAULT_PUBLISHING_STALE_MS = 15 * 60 * 1000;
/** Grace for a scheduled job: spacing + retries can legitimately delay it. */
export const DEFAULT_OVERDUE_QUEUED_MS = 10 * 60 * 1000;
/** Rows per sweep. A backlog is drained across ticks, never in one giant batch. */
export const DEFAULT_REAP_LIMIT = 50;

export const STALE_PUBLISHING_ERROR_CODE = "PUBLISH_FAILED";
export const STALE_PUBLISHING_REASON = "PUBLISHING_STALE";

export interface ReapPostJobsInput {
  /** Overrides for one run (tests, manual sweep). Defaults above otherwise. */
  readonly publishingStaleMs?: number;
  readonly overdueQueuedMs?: number;
  readonly limit?: number;
}

export interface ReapedJob {
  readonly postJobId: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly channelId: string;
  readonly outcome: "failed" | "requeued" | "skipped";
  readonly reason: string;
  readonly queueJobId?: string | null;
}

export interface ReapPostJobsResult {
  readonly scannedStalePublishing: number;
  readonly scannedOverdueQueued: number;
  readonly failed: number;
  readonly requeued: number;
  readonly skipped: number;
  readonly jobs: readonly ReapedJob[];
  readonly durationMs: number;
}

export interface ReapPostJobsDeps {
  postJobs: PostJobRepo;
  queue: JobQueue;
  channels: ChannelConfigRepo;
  clock: Clock;
  logger: Logger;
}

export function makeReapPostJobs(deps: ReapPostJobsDeps) {
  return async function reapPostJobs(
    input: ReapPostJobsInput = {},
  ): Promise<ReapPostJobsResult> {
    // --- Edge cases first ---------------------------------------------------
    const publishingStaleMs = positiveInt(input?.publishingStaleMs) ?? DEFAULT_PUBLISHING_STALE_MS;
    const overdueQueuedMs = positiveInt(input?.overdueQueuedMs) ?? DEFAULT_OVERDUE_QUEUED_MS;
    const limit = positiveInt(input?.limit) ?? DEFAULT_REAP_LIMIT;

    const startedMs = deps.clock.nowMs();
    const log = deps.logger.child({ component: "post-job-reaper" });
    const jobs: ReapedJob[] = [];

    const stale = await deps.postJobs.findStalePublishing({
      olderThan: new Date(startedMs - publishingStaleMs),
      limit,
    });
    for (const job of stale) {
      jobs.push(await failStalePublishing(deps, job, log, publishingStaleMs));
    }

    // E8.6 — "overdue" is measured against the moment the job should have WOKEN
    // UP (T-30, the start of the handoff window), not against T. A scheduled
    // post whose queue entry vanished must be found while Facebook can still be
    // given the post, not ten minutes after the hour when the only option left
    // is publishing late.
    const overdue = await deps.postJobs.findOverdueQueued({
      dueBefore: new Date(startedMs - overdueQueuedMs + HANDOFF_WINDOW_START_MS),
      limit,
    });
    // One settings read per tenant, not per job: a sweep touching 50 rows of one
    // tenant must not make 50 identical queries.
    const settingsByTenant = new Map<string, { maxAttempts: number; retryBackoffMs: number }>();
    for (const job of overdue) {
      jobs.push(await requeueOverdue(deps, job, log, settingsByTenant));
    }

    const result: ReapPostJobsResult = {
      scannedStalePublishing: stale.length,
      scannedOverdueQueued: overdue.length,
      failed: jobs.filter((entry) => entry.outcome === "failed").length,
      requeued: jobs.filter((entry) => entry.outcome === "requeued").length,
      skipped: jobs.filter((entry) => entry.outcome === "skipped").length,
      jobs,
      durationMs: deps.clock.nowMs() - startedMs,
    };

    // Always logged, including the quiet runs: "the reaper is alive and found
    // nothing" is the line that proves the sweep is still running at all.
    log.info("Reaper sweep finished", {
      ...result,
      jobs: undefined,
      publishing_stale_ms: publishingStaleMs,
      overdue_queued_ms: overdueQueuedMs,
      limit,
      ...(result.failed + result.requeued > 0 ? { alert: "OPERATOR_ATTENTION" } : {}),
    });
    return result;
  };
}

export type ReapPostJobs = ReturnType<typeof makeReapPostJobs>;

// --- (a) stuck in publishing -------------------------------------------------

async function failStalePublishing(
  deps: ReapPostJobsDeps,
  job: PostJob,
  parentLog: Logger,
  staleMs: number,
): Promise<ReapedJob> {
  const log = parentLog.child({
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
  });

  const userMessage =
    "Bài kẹt ở trạng thái đang đăng quá lâu (worker dừng giữa chừng) — hãy kiểm tra trên kênh rồi bấm Chạy lại nếu bài chưa lên.";
  try {
    const next = transitionPostJob(job, "failed", {
      reason: STALE_PUBLISHING_REASON,
      errorCode: STALE_PUBLISHING_ERROR_CODE,
      errorMessage: userMessage,
    });
    const failed = await deps.postJobs.applyTransition({
      tenantId: job.tenantId,
      postJobId: job.id,
      from: "publishing",
      next,
      reason: STALE_PUBLISHING_REASON,
      auditAction: REAPER_FAILED_AUDIT_ACTION,
      auditPayload: {
        stale_after_ms: staleMs,
        attempt_count: job.attemptCount,
        // Says out loud what the reaper does NOT know.
        note: "Reaper cannot tell whether the platform received this post; it never republishes.",
      },
    });
    if (!failed) {
      // Somebody finished the publish between the scan and the write. Good.
      log.info("Stale publishing job moved on by itself — left alone", {
        reason: "ROW_CHANGED_DURING_SWEEP",
      });
      return reaped(job, "skipped", "ROW_CHANGED_DURING_SWEEP");
    }

    await deps.postJobs.refreshBatchStatus(job.tenantId, job.batchId).catch((error: unknown) => {
      // The batch summary is a cached read model; failing to refresh it must not
      // undo the reap, but it must not be silent either.
      log.warn("Could not refresh the batch summary after reaping", {
        err: AppError.from(error, "DB_ERROR", { tenant_id: job.tenantId, batch_id: job.batchId }),
      });
    });

    log.error("Reaped a job stuck in `publishing` — marked failed, NOT republished", {
      error_code: STALE_PUBLISHING_ERROR_CODE,
      reason: STALE_PUBLISHING_REASON,
      stale_after_ms: staleMs,
      attempt_count: job.attemptCount,
      audit_action: REAPER_FAILED_AUDIT_ACTION,
      alert: "OPERATOR_ATTENTION",
    });
    return reaped(job, "failed", STALE_PUBLISHING_REASON);
  } catch (error) {
    // One bad row must not end the sweep: log it and let the next tick retry.
    log.error("Could not reap a stale publishing job", {
      err: AppError.from(error, "DB_ERROR", { tenant_id: job.tenantId, job_id: job.id }),
      reason: "REAP_FAILED",
      alert: "OPERATOR_ATTENTION",
    });
    return reaped(job, "skipped", "REAP_FAILED");
  }
}

// --- (b) overdue queued with no queue entry ---------------------------------

async function requeueOverdue(
  deps: ReapPostJobsDeps,
  job: PostJob,
  parentLog: Logger,
  settingsByTenant: Map<string, { maxAttempts: number; retryBackoffMs: number }>,
): Promise<ReapedJob> {
  const log = parentLog.child({
    tenant_id: job.tenantId,
    job_id: job.id,
    batch_id: job.batchId,
    product_code: job.productCode,
    channel: job.channelId,
  });

  try {
    // A stored id that STILL exists means the entry is only late (spacing,
    // backoff, a busy worker). Leave it: a second entry would be a second run.
    if (job.queueJobId) {
      const stillQueued = await deps.queue.has(job.queueJobId);
      if (stillQueued) {
        log.debug("Overdue job still has its queue entry — left alone", {
          queue_job_id: job.queueJobId,
          scheduled_at: job.scheduledAt?.toISOString() ?? null,
        });
        return reaped(job, "skipped", "QUEUE_ENTRY_STILL_PRESENT");
      }
    }

    let settings = settingsByTenant.get(job.tenantId);
    if (!settings) {
      const loaded = await deps.channels.getPublishSettings(job.tenantId);
      settings = { maxAttempts: loaded.maxAttempts, retryBackoffMs: loaded.retryBackoffMs };
      settingsByTenant.set(job.tenantId, settings);
    }

    // New id (the old one is gone/unknown) written BEFORE the enqueue, with the
    // optimistic guard: if a worker just claimed the row, we stop here.
    const queueJobId = deferredPostJobQueueId(job, deps.clock.nowMs());
    const pointed = await deps.postJobs.setQueueJobId({
      tenantId: job.tenantId,
      postJobId: job.id,
      queueJobId,
      reason: "REAPER_REQUEUE",
      auditAction: REAPER_REQUEUED_AUDIT_ACTION,
      auditPayload: {
        previous_queue_job_id: job.queueJobId,
        scheduled_at: job.scheduledAt?.toISOString() ?? null,
        overdue_by_ms: job.scheduledAt ? deps.clock.nowMs() - job.scheduledAt.getTime() : null,
      },
    });
    if (!pointed) {
      log.info("Overdue job left `queued` during the sweep — left alone", {
        reason: "ROW_CHANGED_DURING_SWEEP",
      });
      return reaped(job, "skipped", "ROW_CHANGED_DURING_SWEEP");
    }

    try {
      await deps.queue.enqueue(
        PUBLISH_POST_JOB_NAME,
        { tenantId: job.tenantId, postJobId: job.id },
        {
          jobId: queueJobId,
          attempts: settings.maxAttempts,
          backoff: { strategy: "exponential", delayMs: settings.retryBackoffMs },
        },
      );
    } catch (error) {
      // Put the pointer back so the row does not claim an entry that does not
      // exist; the next tick tries again.
      await deps.postJobs
        .setQueueJobId({ tenantId: job.tenantId, postJobId: job.id, queueJobId: job.queueJobId })
        .catch(() => false);
      throw error;
    }

    log.warn("Re-enqueued an overdue scheduled post whose queue entry was gone", {
      previous_queue_job_id: job.queueJobId,
      queue_job_id: queueJobId,
      scheduled_at: job.scheduledAt?.toISOString() ?? null,
      audit_action: REAPER_REQUEUED_AUDIT_ACTION,
      alert: "OPERATOR_ATTENTION",
    });
    return { ...reaped(job, "requeued", "QUEUE_ENTRY_LOST"), queueJobId };
  } catch (error) {
    log.error("Could not re-enqueue an overdue job", {
      err: AppError.from(error, "QUEUE_ERROR", { tenant_id: job.tenantId, job_id: job.id }),
      reason: "REQUEUE_FAILED",
      alert: "OPERATOR_ATTENTION",
    });
    return reaped(job, "skipped", "REQUEUE_FAILED");
  }
}

// --- helpers ----------------------------------------------------------------

function reaped(job: PostJob, outcome: ReapedJob["outcome"], reason: string): ReapedJob {
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
