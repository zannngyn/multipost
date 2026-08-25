import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import {
  deriveBatchStatus,
  isPostFormat,
  isSettledPostJobStatus,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type {
  ApplyTransitionInput,
  ListPostJobsQuery,
  ListScheduledJobsQuery,
  RescheduleJobInput,
  ScheduledJobPage,
  NewPostBatch,
  NewPostJob,
  PostBatchSummary,
  PostJobListItem,
  OverdueScanQuery,
  PostJobEventInput,
  PostJobPage,
  PostJobRepo,
  StaleScanQuery,
  UntouchedQueuedJobs,
  UntouchedQueuedQuery,
  UntouchedQueuedRepo,
} from "@/core/ports/post-job-repo";

import type { Database, DbExecutor } from "./client";
import { findPgError, isPgError, wrapDbError } from "./db-errors";
import { auditLogs, postBatches, postJobEvents, postJobs, type PostJobRow } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

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

/** Postgres unique_violation — the anti-duplicate index firing. */
const PG_UNIQUE_VIOLATION = "23505";

/** Constraint name of a violation, for the log ("which lock stopped me?"). */
function constraintOf(error: unknown): string | null {
  const pgError = findPgError(error) as { constraint_name?: string; constraint?: string } | null;
  return pgError?.constraint_name ?? pgError?.constraint ?? null;
}

function toDomain(row: PostJobRow): PostJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    batchId: row.batchId,
    productCode: row.productCode,
    productOrigin: row.productOrigin,
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
    scheduledPostId: row.scheduledPostId,
    captionText: row.captionText,
    media: row.media ?? [],
    scheduledAt: row.scheduledAt,
    queueJobId: row.queueJobId,
  };
}

/** Domain job + the row timestamps the job log (E11.1) pages and displays by. */
function toListItem(row: PostJobRow): PostJobListItem {
  return { ...toDomain(row), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function emptyCounts(): Record<PostJobStatus, number> {
  return {
    draft: 0,
    queued: 0,
    publishing: 0,
    scheduled_on_facebook: 0,
    published: 0,
    failed: 0,
    blocked: 0,
  };
}

/** Postgres timestamptz comes back as a Date; be tolerant of a driver string. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

export class DrizzlePostJobRepo implements PostJobRepo, UntouchedQueuedRepo {
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
              // undefined would let drizzle omit the column; NULL is the value
              // that means "this run picked nothing, use the tenant setting".
              spacingMs: input.batch.spacingMs ?? null,
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
                productOrigin: job.productOrigin,
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
                product_origin: row.productOrigin,
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
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        // THE anti-duplicate lock firing (business rule 4).
        throw new AppError("DUPLICATE_POST_BLOCKED", {
          message: "A post job already exists for this (batch, code, colour, channel, format)",
          // Its OWN sentence, not the generic one for this code. Two very
          // different events raise DUPLICATE_POST_BLOCKED — this one (the lock
          // stopped a second identical batch, nothing was sent anywhere) and a
          // refused retry (a post may already be on the Page) — and they need
          // opposite instructions. The presenter cannot tell them apart, so the
          // next step has to be written where the cause is known.
          userMessage:
            "Lô này đã có bài cho đúng mã sản phẩm / màu / kênh / định dạng đó — đã chặn tạo trùng, " +
            "chưa có gì được gửi lên kênh. Hãy mở nhật ký đăng của lô để xem bài đã tạo trước đó; " +
            "nếu muốn đăng lại thì chạy lại chính bài đó thay vì tạo lô mới.",
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
      throw wrapDbError(error, {
        operation: "postJob.createBatchWithJobs",
        tenant_id: scope.tenantId,
        batch_id: input.batch.id,
        field: "batchId",
      });
    }
  }

  async findJobById(tenantId: TenantId, postJobId: string): Promise<PostJob | null> {
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
      throw wrapDbError(error, {
        operation: "postJob.findJobById",
        tenant_id: scope.tenantId,
        job_id: id,
        field: "postJobId",
      });
    }
  }

  async listJobsByBatch(tenantId: TenantId, batchId: string): Promise<readonly PostJob[]> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, eq(postJobs.batchId, batchId)))
        .orderBy(postJobs.channelId);
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.listJobsByBatch",
        tenant_id: scope.tenantId,
        batch_id: batchId,
        field: "batchId",
      });
    }
  }

  /**
   * E11.1 job log. Keyset pagination on (created_at, id): both columns are read
   * because created_at alone is not unique — two jobs of the same batch are
   * inserted in the same statement, and a created_at-only cursor would drop the
   * second one from the next page.
   *
   * Reads `limit + 1` rows to tell "there is more" from "that was the last page"
   * without a second COUNT query.
   */
  async listJobs(query: ListPostJobsQuery): Promise<PostJobPage> {
    const scope = forTenant(this.db, query.tenantId);
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 20;

    const filters: Array<SQL | undefined> = [];
    if (query?.batchId) filters.push(eq(postJobs.batchId, query.batchId));
    if (query?.status) filters.push(eq(postJobs.status, query.status));
    if (query?.channelId) filters.push(eq(postJobs.channelId, query.channelId));
    if (query?.productCode) filters.push(eq(postJobs.productCode, query.productCode));
    if (query?.cursor) {
      // "Strictly older than the last row already shown", written out instead of
      // a row-value comparison: a `(a, b) < ($1, $2)` tuple leaves Postgres
      // guessing the parameter types (it fails on the timestamptz), while these
      // operators carry the column types drizzle already knows.
      filters.push(
        or(
          lt(postJobs.createdAt, query.cursor.createdAt),
          and(eq(postJobs.createdAt, query.cursor.createdAt), lt(postJobs.id, query.cursor.id)),
        ),
      );
    }

    try {
      const rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, ...filters))
        .orderBy(desc(postJobs.createdAt), desc(postJobs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(toListItem),
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.listJobs",
        tenant_id: scope.tenantId,
        batch_id: query?.batchId ?? null,
        channel: query?.channelId ?? null,
        status: query?.status ?? null,
        field: "filter",
      });
    }
  }

  /**
   * Optimistic transition. The WHERE clause carries the expected status, so the
   * database — not the application — decides who wins a race. 0 rows updated
   * means somebody else moved first: the caller stops instead of publishing.
   */
  async applyTransition(input: ApplyTransitionInput): Promise<PostJob | null> {
    const scope = forTenant(this.db, input.tenantId);
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
            // E8.6: the id of the post Facebook is holding travels with the
            // status too, or a handed-over job could not be reconciled.
            scheduledPostId: next.scheduledPostId,
            // Written in the SAME statement as the status: a `queued` row whose
            // queue id was lost cannot be cancelled or rescheduled (E8.4).
            queueJobId: next.queueJobId,
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
            // Default names the state; a caller may name the EVENT instead
            // (E8.3 auto-cancel, E8.5 scheduled publish failure).
            action: input.auditAction ?? `post_job.${next.status}`,
            entityType: "post_job",
            entityId: row.id,
            payload: {
              // Caller extras first: the fields below are the record of what
              // actually happened and must win over anything passed in.
              ...(input.auditPayload ?? {}),
              batch_id: row.batchId,
              product_code: row.productCode,
              channel: row.channelId,
              from: input.from,
              to: next.status,
              reason: input.reason,
              scheduled_at: row.scheduledAt?.toISOString() ?? null,
              attempt_count: row.attemptCount,
              error_code: row.lastErrorCode,
              published_post_id: row.publishedPostId,
            },
          }),
        );

        return toDomain(row);
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.applyTransition",
        tenant_id: scope.tenantId,
        job_id: input.postJobId,
        from: input.from,
        to: next.status,
        field: "postJobId",
      });
    }
  }

  async setQueueJobId(input: {
    tenantId: TenantId;
    postJobId: string;
    queueJobId: string | null;
    auditAction?: string;
    auditPayload?: Readonly<Record<string, unknown>>;
    reason?: string;
    actorUserId?: string | null;
  }): Promise<boolean> {
    const scope = forTenant(this.db, input.tenantId);
    const id = typeof input?.postJobId === "string" ? input.postJobId.trim() : "";
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "setQueueJobId requires a post job id",
        userMessage: "Thiếu mã bài đăng.",
        context: { tenant_id: scope.tenantId },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const rows = await tx
          .update(postJobs)
          .set({ queueJobId: input.queueJobId, updatedAt: new Date() })
          .where(txScope.where(postJobs, and(eq(postJobs.id, id), eq(postJobs.status, "queued"))))
          .returning();

        const row = rows[0];
        if (!row) return false;

        // Only when the caller names an event: routine re-pointing (spacing
        // deferral) would otherwise flood the trail with noise.
        if (input.auditAction) {
          await tx.insert(auditLogs).values(
            txScope.row({
              actorUserId: input.actorUserId ?? null,
              action: input.auditAction,
              entityType: "post_job",
              entityId: row.id,
              payload: {
                ...(input.auditPayload ?? {}),
                batch_id: row.batchId,
                product_code: row.productCode,
                channel: row.channelId,
                reason: input.reason ?? "QUEUE_ID_UPDATED",
                queue_job_id: input.queueJobId,
                scheduled_at: row.scheduledAt?.toISOString() ?? null,
              },
            }),
          );
        }
        return true;
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.setQueueJobId",
        tenant_id: scope.tenantId,
        job_id: id,
        field: "postJobId",
      });
    }
  }

  /**
   * E8.4 — move a scheduled job to another time.
   *
   * `WHERE status = 'queued'` is the whole safety story: if a worker claimed the
   * job while the operator was typing, 0 rows change and the caller reports it
   * instead of rewriting the schedule of a post that is already going out.
   */
  async rescheduleJob(input: RescheduleJobInput): Promise<PostJob | null> {
    const scope = forTenant(this.db, input.tenantId);
    const id = typeof input?.postJobId === "string" ? input.postJobId.trim() : "";
    if (id.length === 0 || !(input?.scheduledAt instanceof Date)) {
      throw new AppError("INVALID_INPUT", {
        message: "rescheduleJob requires a post job id and a scheduled time",
        userMessage: "Yêu cầu đổi giờ đăng không hợp lệ.",
        context: { tenant_id: scope.tenantId, job_id: id || null },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        const txScope = forTenant(tx, scope.tenantId);
        const rows = await tx
          .update(postJobs)
          .set({
            scheduledAt: input.scheduledAt,
            queueJobId: input.queueJobId,
            updatedAt: new Date(),
          })
          .where(
            txScope.where(
              postJobs,
              and(eq(postJobs.id, id), eq(postJobs.status, "queued")),
            ),
          )
          .returning();

        const row = rows[0];
        if (!row) return null;

        await tx.insert(auditLogs).values(
          txScope.row({
            actorUserId: input.actorUserId ?? null,
            action: "post_job.rescheduled",
            entityType: "post_job",
            entityId: row.id,
            payload: {
              batch_id: row.batchId,
              product_code: row.productCode,
              channel: row.channelId,
              reason: input.reason,
              from_scheduled_at: input.previousScheduledAt?.toISOString() ?? null,
              to_scheduled_at: input.scheduledAt.toISOString(),
              from_queue_job_id: input.previousQueueJobId,
              to_queue_job_id: input.queueJobId,
            },
          }),
        );

        return toDomain(row);
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.rescheduleJob",
        tenant_id: scope.tenantId,
        job_id: id,
        field: "postJobId",
      });
    }
  }

  /**
   * E8.4 — the "bài đã hẹn" screen: queued jobs with a publish time, SOONEST
   * FIRST (the opposite of the job log: here the next thing to happen matters).
   * Keyset on (scheduled_at, id) for the same reason as listJobs.
   */
  async listScheduledJobs(query: ListScheduledJobsQuery): Promise<ScheduledJobPage> {
    const scope = forTenant(this.db, query.tenantId);
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 20;

    const filters: Array<SQL | undefined> = [
      // E8.6: a post Facebook already holds is still "bài đã hẹn" — hiding it
      // between the handoff and the hour would make it look lost.
      inArray(postJobs.status, ["queued", "scheduled_on_facebook"]),
      isNotNull(postJobs.scheduledAt),
    ];
    if (query?.from instanceof Date) filters.push(gte(postJobs.scheduledAt, query.from));
    if (query?.to instanceof Date) filters.push(lt(postJobs.scheduledAt, query.to));
    if (query?.channelId) filters.push(eq(postJobs.channelId, query.channelId));
    if (query?.cursor) {
      filters.push(
        or(
          gt(postJobs.scheduledAt, query.cursor.scheduledAt),
          and(eq(postJobs.scheduledAt, query.cursor.scheduledAt), gt(postJobs.id, query.cursor.id)),
        ),
      );
    }

    try {
      const rows = await scope.db
        .select()
        .from(postJobs)
        .where(scope.where(postJobs, ...filters))
        .orderBy(postJobs.scheduledAt, postJobs.id)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(toListItem),
        // scheduled_at is NOT NULL in every row here (the filter guarantees it).
        nextCursor:
          hasMore && last?.scheduledAt ? { scheduledAt: last.scheduledAt, id: last.id } : null,
      };
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.listScheduledJobs",
        tenant_id: scope.tenantId,
        channel: query?.channelId ?? null,
        field: "filter",
      });
    }
  }

  /**
   * E11 worker-health probe — "how many jobs of this tenant are queued and were
   * never even attempted?". Tenant-scoped like everything else here.
   *
   * THE SUBTLE PART is the scheduled_at predicate. `queued` holds two very
   * different populations:
   *   - a post meant to go out now (scheduled_at IS NULL), and
   *   - a post waiting for its hour (scheduled_at in the future) — E8.4.
   * The second one is `attempt_count = 0` by DESIGN; counting it would turn
   * every planned post into a "worker is down" alarm. Only jobs with no hour,
   * or whose hour has already passed, are symptoms.
   *
   * The waiting-since instant is `greatest(created_at, scheduled_at)`: a post
   * scheduled for last Tuesday and created yesterday has been waiting since
   * yesterday, and one created last month for 5 minutes ago has been waiting 5
   * minutes. Taking created_at alone would report days of delay the moment a
   * long-planned post becomes due.
   *
   * Runs on the existing (tenant_id, status) index; no migration needed.
   */
  async countUntouchedQueued(query: UntouchedQueuedQuery): Promise<UntouchedQueuedJobs> {
    const scope = forTenant(this.db, query.tenantId);
    const now = query?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new AppError("INVALID_INPUT", {
        message: "countUntouchedQueued requires the current time",
        userMessage: "Không kiểm tra được tình trạng hàng đợi: thiếu mốc thời gian.",
        context: { tenant_id: scope.tenantId, operation: "postJob.countUntouchedQueued" },
      });
    }

    try {
      const rows = await scope.db
        .select({
          total: count(),
          waitingSince: sql`min(greatest(${postJobs.createdAt}, coalesce(${postJobs.scheduledAt}, ${postJobs.createdAt})))`,
        })
        .from(postJobs)
        .where(
          scope.where(
            postJobs,
            eq(postJobs.status, "queued"),
            eq(postJobs.attemptCount, 0),
            or(isNull(postJobs.scheduledAt), lte(postJobs.scheduledAt, now)),
          ),
        );

      const row = rows[0];
      const total = Number.isFinite(row?.total) ? Number(row?.total) : 0;
      // No rows -> min() is NULL; never report a wait without a job to blame.
      return {
        count: total,
        oldestWaitingSince: total > 0 ? toDate(row?.waitingSince) : null,
      };
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.countUntouchedQueued",
        tenant_id: scope.tenantId,
        now: now.toISOString(),
        field: "tenantId",
      });
    }
  }

  /**
   * CROSS-TENANT SCAN — the one place in this file that does not go through
   * `forTenant` (business rule 7's documented exception, mirrored in the port).
   *
   * Why it must be: the reaper runs from the queue with no tenant in scope, and
   * a job stuck in `publishing` is exactly the row nobody is watching. The
   * result never leaves the worker; every follow-up write IS tenant-scoped,
   * because it goes through applyTransition with the row's own tenant id.
   */
  async findStalePublishing(query: StaleScanQuery): Promise<readonly PostJob[]> {
    const olderThan = query?.olderThan;
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 50;
    if (!(olderThan instanceof Date) || !Number.isFinite(olderThan.getTime())) {
      throw new AppError("INVALID_INPUT", {
        message: "findStalePublishing requires an `olderThan` date",
        userMessage: "Tham số quét bài kẹt không hợp lệ.",
        context: { operation: "postJob.findStalePublishing" },
      });
    }

    try {
      const rows = await this.db
        .select()
        .from(postJobs)
        .where(and(eq(postJobs.status, "publishing"), lt(postJobs.updatedAt, olderThan)))
        .orderBy(postJobs.updatedAt)
        .limit(limit);
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.findStalePublishing",
        older_than: olderThan.toISOString(),
        scope: "CROSS_TENANT",
      });
    }
  }

  /** CROSS-TENANT SCAN — see the note on findStalePublishing. */
  async findOverdueQueued(query: OverdueScanQuery): Promise<readonly PostJob[]> {
    const dueBefore = query?.dueBefore;
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 50;
    if (!(dueBefore instanceof Date) || !Number.isFinite(dueBefore.getTime())) {
      throw new AppError("INVALID_INPUT", {
        message: "findOverdueQueued requires a `dueBefore` date",
        userMessage: "Tham số quét bài quá giờ không hợp lệ.",
        context: { operation: "postJob.findOverdueQueued" },
      });
    }

    try {
      const rows = await this.db
        .select()
        .from(postJobs)
        .where(
          and(
            eq(postJobs.status, "queued"),
            isNotNull(postJobs.scheduledAt),
            lt(postJobs.scheduledAt, dueBefore),
          ),
        )
        .orderBy(postJobs.scheduledAt)
        .limit(limit);
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.findOverdueQueued",
        due_before: dueBefore.toISOString(),
        scope: "CROSS_TENANT",
      });
    }
  }

  /** CROSS-TENANT SCAN — see the note on findStalePublishing. */
  async findScheduledOnPlatformDue(query: OverdueScanQuery): Promise<readonly PostJob[]> {
    const dueBefore = query?.dueBefore;
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 50;
    if (!(dueBefore instanceof Date) || !Number.isFinite(dueBefore.getTime())) {
      throw new AppError("INVALID_INPUT", {
        message: "findScheduledOnPlatformDue requires a `dueBefore` date",
        userMessage: "Tham số quét bài đã giao cho Facebook không hợp lệ.",
        context: { operation: "postJob.findScheduledOnPlatformDue" },
      });
    }

    try {
      const rows = await this.db
        .select()
        .from(postJobs)
        .where(
          and(
            eq(postJobs.status, "scheduled_on_facebook"),
            isNotNull(postJobs.scheduledAt),
            lt(postJobs.scheduledAt, dueBefore),
          ),
        )
        .orderBy(postJobs.scheduledAt)
        .limit(limit);
      return rows.map(toDomain);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.findScheduledOnPlatformDue",
        due_before: dueBefore.toISOString(),
        scope: "CROSS_TENANT",
      });
    }
  }

  async findLastPublishedAt(tenantId: TenantId, channelId: string): Promise<Date | null> {
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
      throw wrapDbError(error, {
        operation: "postJob.findLastPublishedAt",
        tenant_id: scope.tenantId,
        channel,
        field: "channelId",
      });
    }
  }

  /**
   * The run's own spacing (E7 spacing gate). One column, one row: this runs on
   * every publish attempt, so it must not drag the batch's jobs along with it.
   *
   * A batch that does not exist reads as null rather than throwing: post_job
   * .batch_id is a FK, so the caller cannot be holding a job whose batch is
   * gone, and inventing a failure here would stop a publish over a row the gate
   * only needed an OPTIONAL value from.
   */
  async findBatchSpacingMs(tenantId: TenantId, batchId: string): Promise<number | null> {
    const scope = forTenant(this.db, tenantId);
    const id = typeof batchId === "string" ? batchId.trim() : "";
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findBatchSpacingMs requires a batch id",
        userMessage: "Thiếu mã lô bài đăng.",
        context: { tenant_id: scope.tenantId },
      });
    }

    try {
      const rows = await scope.db
        .select({ spacingMs: postBatches.spacingMs })
        .from(postBatches)
        .where(scope.where(postBatches, eq(postBatches.id, id)))
        .limit(1);
      const value = rows[0]?.spacingMs ?? null;
      // The driver hands back int4 as a number; anything else means the column
      // type changed under us, and guessing would silently change the gate.
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.findBatchSpacingMs",
        tenant_id: scope.tenantId,
        batch_id: id,
        field: "batchId",
      });
    }
  }

  async refreshBatchStatus(tenantId: TenantId, batchId: string): Promise<PostBatchSummary> {
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
      throw wrapDbError(error, {
        operation: "postJob.refreshBatchStatus",
        tenant_id: scope.tenantId,
        batch_id: batchId,
        field: "batchId",
      });
    }
    return summary;
  }

  async getBatchSummary(tenantId: TenantId, batchId: string): Promise<PostBatchSummary | null> {
    return this.buildSummary(this.db, tenantId, batchId);
  }

  /**
   * E7.5 — one milestone row (design §5.4). Deliberately NOT part of the
   * publish transaction: a note about a post must never be able to roll a post
   * back, and it must survive the transitions it describes.
   *
   * It still throws like every other method here. The decision that telemetry
   * may not stop a publish belongs to the caller, which owns the post; a repo
   * that silently ate its own INSERT would make "the trail has a hole" an
   * unanswerable question.
   */
  async appendJobEvent(input: PostJobEventInput): Promise<void> {
    const scope = forTenant(this.db, input.tenantId);
    const postJobId = typeof input?.postJobId === "string" ? input.postJobId.trim() : "";
    const batchId = typeof input?.batchId === "string" ? input.batchId.trim() : "";
    const stage = typeof input?.stage === "string" ? input.stage.trim() : "";
    if (postJobId.length === 0 || batchId.length === 0 || stage.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "appendJobEvent requires a post job id, a batch id and a stage",
        userMessage: "Thiếu thông tin để ghi mốc tiến độ của bài đăng.",
        context: {
          tenant_id: scope.tenantId,
          job_id: postJobId || null,
          batch_id: batchId || null,
          stage: stage || null,
        },
      });
    }

    const occurredAt =
      input?.occurredAt instanceof Date && Number.isFinite(input.occurredAt.getTime())
        ? input.occurredAt
        : new Date();
    const attempt =
      typeof input?.attempt === "number" && Number.isFinite(input.attempt)
        ? Math.max(0, Math.floor(input.attempt))
        : 0;

    try {
      await scope.db.insert(postJobEvents).values(
        scope.row({
          postJobId,
          batchId,
          stage,
          attempt,
          detail: { ...(input?.detail ?? {}) },
          occurredAt,
        }),
      );
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.appendJobEvent",
        tenant_id: scope.tenantId,
        job_id: postJobId,
        batch_id: batchId,
        stage,
        field: "postJobId",
      });
    }
  }

  private async buildSummary(
    db: DbExecutor,
    tenantId: TenantId,
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
      throw wrapDbError(error, {
        operation: "postJob.buildSummary",
        tenant_id: scope.tenantId,
        batch_id: id,
        field: "batchId",
      });
    }

    if (rows.length === 0) return null;

    let batchCreatedAt: Date | null;
    try {
      const batchRows = await scope.db
        .select({ createdAt: postBatches.createdAt })
        .from(postBatches)
        .where(scope.where(postBatches, eq(postBatches.id, id)))
        .limit(1);
      batchCreatedAt = batchRows[0]?.createdAt ?? null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postJob.buildSummary.batchRow",
        tenant_id: scope.tenantId,
        batch_id: id,
        field: "batchId",
      });
    }

    const jobs = rows.map(toDomain);
    const byStatus = emptyCounts();
    for (const job of jobs) byStatus[job.status] += 1;

    // The batch row always exists (post_job.batch_id is a FK), but a summary
    // must not invent a time if it somehow does not: fall back to the oldest job.
    const startedAt =
      batchCreatedAt ?? new Date(Math.min(...rows.map((row) => row.createdAt.getTime())));
    // Only a run where NOTHING is still moving has an end time (rule: an
    // unfinished batch showing a finish time would look complete).
    const settled = jobs.every((job) => isSettledPostJobStatus(job.status));
    const finishedAt = settled
      ? new Date(Math.max(...rows.map((row) => row.updatedAt.getTime())))
      : null;

    return {
      batchId: id,
      tenantId: scope.tenantId,
      productCode: jobs[0].productCode,
      status: deriveBatchStatus(jobs.map((job) => job.status)),
      total: jobs.length,
      byStatus,
      startedAt,
      finishedAt,
      jobs,
    };
  }
}
