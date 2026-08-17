/**
 * Post batch/job persistence ports (E7). Pure TypeScript: types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - Every statement is tenant-scoped (business rule 7); a bad tenant id throws
 *   AppError('INVALID_INPUT').
 * - Driver failures surface as AppError('DB_ERROR') with tenant/job context.
 * - `createBatchWithJobs` is ONE transaction, and a violation of the unique
 *   (tenant, batch, code, colour, channel, format) index throws
 *   AppError('DUPLICATE_POST_BLOCKED') — this is the anti-duplicate lock of
 *   business rule 4, taken BEFORE any publish call.
 * - `applyTransition` is optimistic: it updates WHERE status = `from`, so two
 *   workers racing for the same job cannot both claim it. The loser gets null.
 */

import type {
  PostBatchStatus,
  PostFormat,
  PostJob,
  PostJobMedia,
  PostJobStatus,
} from "@/core/domain/post-job";
import type { PostJobStage } from "@/core/domain/post-job-progress";

export interface NewPostBatch {
  /** Caller-supplied id = the idempotency scope of the anti-duplicate lock. */
  readonly id: string;
  readonly tenantId: string;
  readonly productCode: string;
  /** "" means "every colour of this code" — never null (see PostJob.color). */
  readonly color: string;
  readonly format: PostFormat;
  readonly note: string | null;
  /** Operator user id; null for system/worker-created batches. */
  readonly createdBy: string | null;
}

export interface NewPostJob {
  readonly id: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly productCode: string;
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
  readonly captionText: string;
  readonly media: readonly PostJobMedia[];
  readonly scheduledAt: Date | null;
}

export interface ApplyTransitionInput {
  readonly tenantId: string;
  readonly postJobId: string;
  /** Status the row MUST still have — the optimistic guard. */
  readonly from: PostJobStatus;
  /** Job already validated by `transitionPostJob` (domain owns the rules). */
  readonly next: PostJob;
  /** Machine-readable why, stored in the audit trail. */
  readonly reason: string;
  readonly actorUserId?: string | null;
  /**
   * Overrides the audit action (default `post_job.<new status>`). Used when the
   * STATUS alone hides what happened: a scheduled post killed by the stock
   * recheck is `post_job.auto_cancelled` (E8.3), not a plain "blocked".
   */
  readonly auditAction?: string;
  /**
   * Extra fields merged into the audit payload (an operator note, a cancel
   * reason...). Merged UNDER the repo's own fields, so a caller cannot overwrite
   * `from`/`to`/`reason` and rewrite history.
   */
  readonly auditPayload?: Readonly<Record<string, unknown>>;
}

/** E8.4 — change the publish time of a job that has not run yet. */
export interface RescheduleJobInput {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly scheduledAt: Date;
  /** New queue entry id; replaces the stored one. */
  readonly queueJobId: string;
  /** Previous values, for the audit row. */
  readonly previousScheduledAt: Date | null;
  readonly previousQueueJobId: string | null;
  readonly actorUserId?: string | null;
  readonly reason: string;
}

/** E8.4 — "bài đã hẹn" list, ordered by publish time (soonest first). */
export interface ScheduledJobCursor {
  readonly scheduledAt: Date;
  readonly id: string;
}

export interface ListScheduledJobsQuery {
  readonly tenantId: string;
  /** Inclusive lower bound on scheduled_at. */
  readonly from?: Date;
  /** Exclusive upper bound on scheduled_at. */
  readonly to?: Date;
  readonly channelId?: string;
  readonly limit: number;
  readonly cursor?: ScheduledJobCursor;
}

export interface ScheduledJobPage {
  readonly items: readonly PostJobListItem[];
  readonly nextCursor: ScheduledJobCursor | null;
}

export interface PostBatchSummary {
  readonly batchId: string;
  readonly tenantId: string;
  readonly productCode: string;
  readonly status: PostBatchStatus;
  readonly total: number;
  readonly byStatus: Readonly<Record<PostJobStatus, number>>;
  /** When the batch was created — the "bắt đầu" column of brief §6. */
  readonly startedAt: Date;
  /**
   * When the LAST job settled (published/failed/blocked). Null while anything is
   * still draft/queued/publishing — an unfinished run must never show an end
   * time.
   */
  readonly finishedAt: Date | null;
  /** Per-channel result table of brief §3/§6 (link included when published). */
  readonly jobs: readonly PostJob[];
}

/** A post job plus its row timestamps — the job log of E11.1 needs both. */
export interface PostJobListItem extends PostJob {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Keyset cursor: the (createdAt, id) of the LAST item already returned. Opaque
 * to the caller — core encodes/decodes it (core/usecases/list-post-jobs.ts), the
 * adapter only compares it. Keyset, not OFFSET: the job list changes while an
 * operator pages through it, and OFFSET would skip or repeat rows.
 */
export interface PostJobCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListPostJobsQuery {
  readonly tenantId: string;
  readonly batchId?: string;
  readonly status?: PostJobStatus;
  readonly channelId?: string;
  readonly productCode?: string;
  /** Rows to read; the usecase caps it. */
  readonly limit: number;
  readonly cursor?: PostJobCursor;
}

export interface PostJobPage {
  /** Newest first (createdAt DESC, id DESC). */
  readonly items: readonly PostJobListItem[];
  /** Cursor of the last item when another page may exist, else null. */
  readonly nextCursor: PostJobCursor | null;
}

/**
 * CROSS-TENANT scan input (reaper). Deliberately has NO tenantId: the reaper is
 * a system job that must find stuck rows in EVERY tenant — see the note on the
 * repo methods below.
 */
export interface StaleScanQuery {
  /** Rows untouched since this instant are considered stuck. */
  readonly olderThan: Date;
  /** Hard cap per run, so one bad hour cannot produce an unbounded batch. */
  readonly limit: number;
}

export interface OverdueScanQuery {
  /** Scheduled time is before this instant (i.e. the hour has come and gone). */
  readonly dueBefore: Date;
  readonly limit: number;
}

/**
 * E7.5 — ONE milestone of a running post job (design §5.4). Written when the
 * STAGE changes, never per photo: roughly 6-8 rows per post.
 */
export interface PostJobEventInput {
  readonly tenantId: string;
  readonly postJobId: string;
  readonly batchId: string;
  readonly stage: PostJobStage;
  /** Publish attempt this milestone belongs to. */
  readonly attempt: number;
  /** Numbers of the milestone: `{ done: 10, total: 10 }`, `{ wait_ms: 45000 }`. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Worker clock at the moment of the change, not the insert time. */
  readonly occurredAt: Date;
}

export interface PostJobRepo {
  /** Batch + all its jobs in one transaction. See the duplicate note above. */
  createBatchWithJobs(input: {
    readonly batch: NewPostBatch;
    readonly jobs: readonly NewPostJob[];
  }): Promise<{ readonly batchId: string; readonly jobs: readonly PostJob[] }>;

  findJobById(tenantId: string, postJobId: string): Promise<PostJob | null>;

  listJobsByBatch(tenantId: string, batchId: string): Promise<readonly PostJob[]>;

  /**
   * E11.1 job log. Filters are AND-ed; `limit` is read as given (the usecase
   * already capped it) and the page is ordered newest first.
   */
  listJobs(query: ListPostJobsQuery): Promise<PostJobPage>;

  /** Returns the updated job, or null when another worker won the race. */
  applyTransition(input: ApplyTransitionInput): Promise<PostJob | null>;

  /**
   * Points the row at ANOTHER queue entry while it stays `queued` (spacing
   * deferral, operator retry). No audit row: this is plumbing, not a state
   * change — but it must happen, or the new entry looks stale to the guard in
   * publish-post. False = the row was no longer `queued`.
   */
  setQueueJobId(input: {
    readonly tenantId: string;
    readonly postJobId: string;
    readonly queueJobId: string | null;
    /** When given, an audit row is written in the SAME transaction. */
    readonly auditAction?: string;
    readonly auditPayload?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
    readonly actorUserId?: string | null;
  }): Promise<boolean>;

  /**
   * E8.4 — new publish time + new queue id, ONLY while the row is still
   * `queued` (same optimistic guard as applyTransition: null = a worker claimed
   * the job first and the operator must be told, not silently overruled).
   * Writes its own audit row.
   */
  rescheduleJob(input: RescheduleJobInput): Promise<PostJob | null>;

  /** E8.4 — jobs waiting for their scheduled time, soonest first. */
  listScheduledJobs(query: ListScheduledJobsQuery): Promise<ScheduledJobPage>;

  /**
   * Jobs stuck in `publishing` since before `olderThan` — a worker died between
   * the claim and the result, and nothing else will ever move them.
   *
   * CROSS-TENANT ON PURPOSE (the documented exception to business rule 7): the
   * reaper is a system job with no tenant in its payload, and scanning tenant by
   * tenant would need a tenant registry the queue does not have. Nothing here
   * leaves the worker: the rows are only transitioned and logged.
   */
  findStalePublishing(query: StaleScanQuery): Promise<readonly PostJob[]>;

  /**
   * Jobs still `queued` whose scheduled time passed before `dueBefore`.
   * CROSS-TENANT, same exception and same reasoning as above.
   */
  findOverdueQueued(query: OverdueScanQuery): Promise<readonly PostJob[]>;

  /**
   * E8.6 — jobs the platform is holding (`scheduled_on_facebook`) whose hour
   * passed before `dueBefore`. The input of the reconciliation sweep: Facebook
   * publishes them itself and tells nobody, so something has to ask.
   * CROSS-TENANT, same exception and same reasoning as above.
   */
  findScheduledOnPlatformDue(query: OverdueScanQuery): Promise<readonly PostJob[]>;

  /**
   * `published_at` of the newest published job on that channel — the input of
   * the spacing gate. Null when the channel never published.
   */
  findLastPublishedAt(tenantId: string, channelId: string): Promise<Date | null>;

  /** Recomputes and stores post_batch.status from its jobs; returns the summary. */
  refreshBatchStatus(tenantId: string, batchId: string): Promise<PostBatchSummary>;

  getBatchSummary(tenantId: string, batchId: string): Promise<PostBatchSummary | null>;

  /**
   * E7.5 — appends ONE progress milestone (design §5.4). Not part of the
   * publish transaction: a milestone is a note about a post, never the post.
   *
   * Failures surface as AppError('DB_ERROR') like every other method here — the
   * CALLER decides that telemetry may not stop a publish (see the reportStage
   * helper in core/usecases/publish-post.ts), so this implementer stays honest
   * about what it did and did not write.
   */
  appendJobEvent(input: PostJobEventInput): Promise<void>;
}
