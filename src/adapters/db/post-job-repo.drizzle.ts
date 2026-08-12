import { and, desc, eq, isNotNull } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import {
  deriveBatchStatus,
  isPostFormat,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type {
  ApplyTransitionInput,
  NewPostBatch,
  NewPostJob,
  PostBatchSummary,
  PostJobRepo,
} from "@/core/ports/post-job-repo";

import type { Database, DbExecutor } from "./client";
import { auditLogs, postBatches, postJobs, type PostJobRow } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * post_batch / post_job persistence (E7). Everything goes through the tenant
 * scope, and every driver failure becomes an AppError with enough context to
 * answer "why is this post not live?".
 *
 * Two protections live in this file:
 *  1. the UNIQUE violation on post_job_duplicate_uq is translated into
 *     DUPLICATE_POST_BLOCKED — the anti-duplicate lock of business rule 4;
 *  2. `applyTransition` updates WHERE status = <expected>, so two workers
 *     racing for the same job cannot both claim it (the loser gets null).
 *
 * Every accepted transition also writes an audit_log row in the SAME
 * transaction: a state change without a trace never happens.
 */

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

interface PgError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Drizzle wraps driver errors (DrizzleQueryError), so the SQLSTATE lives on the
 * `cause` chain, not on the thrown object. Walking it is the difference between
 * "DUPLICATE_POST_BLOCKED" and a meaningless DB_ERROR.
 */
function findPgError(error: unknown, depth = 0): PgError | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  const candidate = error as PgError & { cause?: unknown };
  if (typeof candidate.code === "string") return candidate;
  return findPgError(candidate.cause, depth + 1);
}

function isUniqueViolation(error: unknown): boolean {
  return findPgError(error)?.code === PG_UNIQUE_VIOLATION;
}

function constraintOf(error: unknown): string | null {
  const pg = findPgError(error);
  return pg?.constraint_name ?? pg?.constraint ?? null;
}

function toDomain(row: PostJobRow): PostJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    batchId: row.batchId,
    productCode: row.productCode,
    color: row.color,
    channelId: row.channelId,
    // Unknown text in the column would corrupt the domain type silently.
    format: isPostFormat(row.format) ? row.format : "image_post",
    status: row.status,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    publishedPostId: row.publishedPostId,
    publishedUrl: row.publishedUrl,
    publishedAt: row.publishedAt,
    captionText: row.captionText,
    media: row.media ?? [],
    scheduledAt: row.scheduledAt,
  };
}

function emptyCounts(): Record<PostJobStatus, number> {
  return { draft: 0, queued: 0, publishing: 0, published: 0, failed: 0, blocked: 0 };
}

export class DrizzlePostJobRepo implements PostJobRepo {
  constructor(private readonly db: Database) {}

  async createBatchWithJobs(input: {
    batch: NewPostBatch;
    jobs: readonly NewPostJob[];
  }): Promise<{ batchId: string; jobs: readonly PostJob[] }> {
    const scope = forTenant(this.db, input?.batch?.tenantId ?? "");
    const jobs = input?.jobs ?? [];
    if (jobs.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "createBatchWithJobs requires at least one job",
        userMessage: "Không có kênh nào để tạo bài đăng.",
        context: { tenant_id: scope.tenantId, batch_id: input?.batch?.id ?? null },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        // Idempotent on the batch row itself: a retried creation must fail on
        // the post_job lock (a real duplicate), not on the batch primary key.
        await tx
          .insert(postBatches)
          .values(
            txScope.row({
              id: input.batch.id,
              productCode: input.batch.productCode,
              color: input.batch.color,
              format: input.batch.format,
              note: input.batch.note,
              createdBy: input.batch.createdBy,
              status: "pending" as const,
            }),
          )
          .onConflictDoNothing({ target: postBatches.id });

        const rows = await tx
          .insert(postJobs)
          .values(
            jobs.map((job) =>
              txScope.row({
                id: job.id,
                batchId: job.batchId,
                productCode: job.productCode,
                color: job.color,
                channelId: job.channelId,
                format: job.format,
                status: "draft" as const,
                captionText: job.captionText,
                media: [...job.media],
                scheduledAt: job.scheduledAt,
              }),
            ),
          )
          .returning();

        for (const row of rows) {
          await tx.insert(auditLogs).values(
            txScope.row({
              actorUserId: input.batch.createdBy ?? null,
              action: "post_job.created",
              entityType: "post_job",
              entityId: row.id,
              payload: {
                batch_id: row.batchId,
                product_code: row.productCode,
                color: row.color,
                channel: row.channelId,
                format: row.format,
                status: row.status,
              },
            }),
          );
        }

        return { batchId: input.batch.id, jobs: rows.map(toDomain) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // THE anti-duplicate lock firing (business rule 4).
        throw new AppError("DUPLICATE_POST_BLOCKED", {
          message: "A post job already exists for this (batch, code, colour, channel, format)",
          context: {
            tenant_id: scope.tenantId,
            batch_id: input.batch.id,
            product_code: input.batch.productCode,
            channels: jobs.map((job) => job.channelId),
            constraint: constraintOf(error),
          },
          cause: error,
        });
      }
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        batch_id: input.batch.id,
        operation: "postJob.createBatchWithJobs",
      });
    }
  }

  async findJobById(tenantId: string, postJobId: string): Promise<PostJob | null> {
    const scope = forTenant(this.db, tenantId);
    const id = typeof postJobId === "string" ? postJobId.trim() : "";
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findJobById requires a post job id",
        userMessage: "Thiếu mã bài đăng.",
        context: { tenant_id: scope.tenantId },
      });
    }

    try {
      const rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, eq(postJobs.id, id)))
        .limit(1);
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        job_id: id,
        operation: "postJob.findJobById",
      });
    }
  }

  async listJobsByBatch(tenantId: string, batchId: string): Promise<readonly PostJob[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, eq(postJobs.batchId, batchId)))
        .orderBy(postJobs.channelId);
      return rows.map(toDomain);
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        batch_id: batchId,
        operation: "postJob.listJobsByBatch",
      });
    }
  }

  /**
   * Optimistic transition. The WHERE clause carries the expected status, so the
   * database — not the application — decides who wins a race. 0 rows updated
   * means somebody else moved first: the caller stops instead of publishing.
   */
  async applyTransition(input: ApplyTransitionInput): Promise<PostJob | null> {
    const scope = forTenant(this.db, input?.tenantId ?? "");
    const next = input?.next;
    if (!next || typeof input?.postJobId !== "string" || input.postJobId.trim().length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "applyTransition requires a post job id and the next job state",
        userMessage: "Yêu cầu cập nhật trạng thái bài đăng không hợp lệ.",
        context: { tenant_id: scope.tenantId, job_id: input?.postJobId ?? null },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const rows = await tx
          .update(postJobs)
          .set({
            status: next.status,
            attemptCount: next.attemptCount,
            lastErrorCode: next.lastErrorCode,
            lastErrorMessage: next.lastErrorMessage,
            publishedPostId: next.publishedPostId,
            publishedUrl: next.publishedUrl,
            publishedAt: next.publishedAt,
            updatedAt: new Date(),
          })
          .where(
            txScope.where(
              postJobs,
              and(eq(postJobs.id, input.postJobId), eq(postJobs.status, input.from)),
            ),
          )
          .returning();

        const row = rows[0];
        if (!row) return null;

        await tx.insert(auditLogs).values(
          txScope.row({
            actorUserId: input.actorUserId ?? null,
            action: `post_job.${next.status}`,
            entityType: "post_job",
            entityId: row.id,
            payload: {
              batch_id: row.batchId,
              product_code: row.productCode,
              channel: row.channelId,
              from: input.from,
              to: next.status,
              reason: input.reason,
              attempt_count: row.attemptCount,
              error_code: row.lastErrorCode,
              published_post_id: row.publishedPostId,
            },
          }),
        );

        return toDomain(row);
      });
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        job_id: input.postJobId,
        from: input.from,
        to: next.status,
        operation: "postJob.applyTransition",
      });
    }
  }

  async findLastPublishedAt(tenantId: string, channelId: string): Promise<Date | null> {
    const scope = forTenant(this.db, tenantId);
    const channel = typeof channelId === "string" ? channelId.trim() : "";
    if (channel.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findLastPublishedAt requires a channel id",
        userMessage: "Thiếu mã kênh.",
        context: { tenant_id: scope.tenantId },
      });
    }

    try {
      const rows = await scope.db
        .select({ publishedAt: postJobs.publishedAt })
        .from(postJobs)
        .where(
          scope.where(
            postJobs,
            and(eq(postJobs.channelId, channel), isNotNull(postJobs.publishedAt)),
          ),
        )
        .orderBy(desc(postJobs.publishedAt))
        .limit(1);
      return rows[0]?.publishedAt ?? null;
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        channel,
        operation: "postJob.findLastPublishedAt",
      });
    }
  }

  async refreshBatchStatus(tenantId: string, batchId: string): Promise<PostBatchSummary> {
    const summary = await this.buildSummary(this.db, tenantId, batchId);
    if (!summary) {
      throw new AppError("INVALID_INPUT", {
        message: "Cannot refresh a batch that has no jobs",
        userMessage: "Không tìm thấy lô bài đăng cần cập nhật.",
        context: { tenant_id: tenantId, batch_id: batchId },
      });
    }

    const scope = forTenant(this.db, tenantId);
    try {
      await scope.db
        .update(postBatches)
        .set({ status: summary.status, updatedAt: new Date() })
        .where(scope.where(postBatches, eq(postBatches.id, batchId)));
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        batch_id: batchId,
        operation: "postJob.refreshBatchStatus",
      });
    }
    return summary;
  }

  async getBatchSummary(tenantId: string, batchId: string): Promise<PostBatchSummary | null> {
    return this.buildSummary(this.db, tenantId, batchId);
  }

  private async buildSummary(
    db: DbExecutor,
    tenantId: string,
    batchId: string,
  ): Promise<PostBatchSummary | null> {
    const scope = forTenant(db, tenantId);
    const id = typeof batchId === "string" ? batchId.trim() : "";
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "A batch summary requires a batch id",
        userMessage: "Thiếu mã lô bài đăng.",
        context: { tenant_id: scope.tenantId },
      });
    }

    let rows: PostJobRow[];
    try {
      rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, eq(postJobs.batchId, id)))
        .orderBy(postJobs.channelId);
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        batch_id: id,
        operation: "postJob.buildSummary",
      });
    }

    if (rows.length === 0) return null;

    const jobs = rows.map(toDomain);
    const byStatus = emptyCounts();
    for (const job of jobs) byStatus[job.status] += 1;

    return {
      batchId: id,
      tenantId: scope.tenantId,
      productCode: jobs[0].productCode,
      status: deriveBatchStatus(jobs.map((job) => job.status)),
      total: jobs.length,
      byStatus,
      jobs,
    };
  }
}
