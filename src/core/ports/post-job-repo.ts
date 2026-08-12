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
   * `published_at` of the newest published job on that channel — the input of
   * the spacing gate. Null when the channel never published.
   */
  findLastPublishedAt(tenantId: string, channelId: string): Promise<Date | null>;

  /** Recomputes and stores post_batch.status from its jobs; returns the summary. */
  refreshBatchStatus(tenantId: string, batchId: string): Promise<PostBatchSummary>;

  getBatchSummary(tenantId: string, batchId: string): Promise<PostBatchSummary | null>;
}
