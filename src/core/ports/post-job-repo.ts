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
import type { ProductOrigin } from "@/core/domain/product";
import type { PostJobStage } from "@/core/domain/post-job-progress";
import type { TenantId } from "@/core/domain/tenant-context";

export interface NewPostBatch {
  /** Caller-supplied id = the idempotency scope of the anti-duplicate lock. */
  readonly id: string;
  readonly tenantId: TenantId;
  readonly productCode: string;
  /** "" means "every colour of this code" — never null (see PostJob.color). */
  readonly color: string;
  readonly format: PostFormat;
  readonly note: string | null;
  /** Operator user id; null for system/worker-created batches. */
  readonly createdBy: string | null;
  /**
   * Gap the spacing gate keeps between two posts of THIS run, in milliseconds.
   * Absent/null = this run picked nothing, so the tenant's
   * `PublishSettings.spacingMs` applies — the behaviour of every batch created
   * before the column existed.
   *
   * Already validated by the creator (core/domain/publish-spacing): an
   * implementer stores it as given and lets the CHECK constraint be the last
   * word. PENDING(E1): still a gap between posts of the SAME CHANNEL.
   */
  readonly spacingMs?: number | null;
}

export interface NewPostJob {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly batchId: string;
  readonly productCode: string;
  /**
   * REQUIRED on the write path even though `PostJob` reads it as optional: the
   * creator always holds the product it built the post from, and defaulting to
   * `sheet` here would invent an origin for a post typed by hand. A caller that
   * cannot say must not guess.
   */
  readonly productOrigin: ProductOrigin;
  readonly color: string;
  readonly channelId: string;
  readonly format: PostFormat;
  readonly captionText: string;
  readonly media: readonly PostJobMedia[];
  readonly scheduledAt: Date | null;
}

export interface ApplyTransitionInput {
  readonly tenantId: TenantId;
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
  readonly tenantId: TenantId;
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
  readonly tenantId: TenantId;
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
  readonly tenantId: TenantId;
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
  readonly tenantId: TenantId;
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
  readonly tenantId: TenantId;
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

/**
 * E11 worker-health probe: "how many of this tenant's jobs are queued and have
 * NEVER been attempted?".
 *
 * `now` is passed in (core owns the clock) because it decides the hardest part
 * of this query: a post with a `scheduled_at` in the FUTURE is queued and
 * untouched on purpose — that is what hẹn giờ means — and counting it would
 * raise a false alarm every time someone schedules a post for tomorrow. Only
 * jobs with no scheduled time, or whose time has already come, are symptoms.
 */
export interface UntouchedQueuedQuery {
  readonly tenantId: TenantId;
  /** Instant the check is made; a `scheduled_at` after it is excluded. */
  readonly now: Date;
}

export interface UntouchedQueuedJobs {
  /** Jobs `queued` with `attempt_count = 0` that should already be running. */
  readonly count: number;
  /**
   * Since when the oldest of them has been WAITING TO BE PICKED UP; null when
   * `count` is 0.
   *
   * Not simply `created_at`: for a scheduled post the wait starts at its hour,
   * not at the moment an operator planned it. Reporting "chờ 7 ngày" for a post
   * that became due one minute ago would make the banner lie.
   */
  readonly oldestWaitingSince: Date | null;
}

/**
 * Narrow read port for the worker-health probe. Kept apart from `PostJobRepo`
 * on purpose: this counter is an operational signal (see WorkerHealth), and
 * nothing that publishes should be handed it.
 */
export interface UntouchedQueuedRepo {
  /** Tenant-scoped. Driver failures surface as AppError('DB_ERROR'). */
  countUntouchedQueued(query: UntouchedQueuedQuery): Promise<UntouchedQueuedJobs>;
}

export interface PostJobRepo {
  /** Batch + all its jobs in one transaction. See the duplicate note above. */
  createBatchWithJobs(input: {
    readonly batch: NewPostBatch;
    readonly jobs: readonly NewPostJob[];
  }): Promise<{ readonly batchId: string; readonly jobs: readonly PostJob[] }>;

  findJobById(tenantId: TenantId, postJobId: string): Promise<PostJob | null>;

  listJobsByBatch(tenantId: TenantId, batchId: string): Promise<readonly PostJob[]>;

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
    readonly tenantId: TenantId;
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
  findLastPublishedAt(tenantId: TenantId, channelId: string): Promise<Date | null>;

  /**
   * The OTHER input of the spacing gate: `post_batch.spacing_ms` for this run.
   *
   * Null means "this run picked nothing" — a batch created before the column
   * existed, or an operator who left the field empty — and the caller then uses
   * the tenant setting, which is exactly the old behaviour.
   *
   * A narrow read on purpose: the gate runs on every publish attempt and must
   * not pay for `getBatchSummary`, which loads every job of the batch.
   * The VALUE is not validated here; core owns the range (resolveSpacingMs), so
   * a row that somehow escaped the CHECK constraint is reported and ignored
   * instead of stranding the job.
   */
  findBatchSpacingMs(tenantId: TenantId, batchId: string): Promise<number | null>;

  /** Recomputes and stores post_batch.status from its jobs; returns the summary. */
  refreshBatchStatus(tenantId: TenantId, batchId: string): Promise<PostBatchSummary>;

  getBatchSummary(tenantId: TenantId, batchId: string): Promise<PostBatchSummary | null>;

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
