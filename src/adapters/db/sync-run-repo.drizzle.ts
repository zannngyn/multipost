import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import {
  SYNC_RUN_STATUSES,
  type FinishSyncRunInput,
  type StartSyncRunInput,
  type SyncIssue,
  type SyncIssueGroup,
  type SyncRunCounts,
  type SyncRunListItem,
  type SyncRunRepo,
  type SyncRunStatus,
  type SyncRunSummary,
} from "@/core/ports/product-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { syncRuns, type SyncRunRow } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Sync-run history (E2). The row is written BEFORE the work starts so a crashed
 * process still leaves a `running` trace instead of nothing.
 */

/**
 * `counts`/`issues` are jsonb: the column type is a promise, not a guarantee.
 * A row written by an older shape must fail loudly instead of reaching the UI
 * as half-filled numbers (CLAUDE.md technical rule 2).
 */
const countsSchema: z.ZodType<SyncRunCounts> = z.object({
  driveFilesSeen: z.number().int(),
  mediaParsed: z.number().int(),
  mediaRejected: z.number().int(),
  mediaDuplicatesDropped: z.number().int(),
  mediaNeedingReview: z.number().int(),
  sheetRowsSeen: z.number().int(),
  productsParsed: z.number().int(),
  sheetRowsRejected: z.number().int(),
  productsWithConflict: z.number().int(),
  productsWithoutMedia: z.number().int(),
  mediaWithoutProduct: z.number().int(),
  productsWritten: z.number().int(),
  mediaWritten: z.number().int(),
  productsDeleted: z.number().int(),
  mediaDeleted: z.number().int(),
  issuesTotal: z.number().int(),
  issuesTruncated: z.boolean(),
});

const issueSchema = z.object({
  errorCode: z.string(),
  reason: z.string(),
  ref: z.string(),
  detail: z.string(),
});

const issuesSchema: z.ZodType<SyncIssue[]> = z.array(issueSchema);

const issueGroupsSchema: z.ZodType<SyncIssueGroup[]> = z.array(
  z.object({
    errorCode: z.string(),
    count: z.number().int(),
    examples: z.array(issueSchema),
  }),
);

/** Shared guards so `findLatest` and `listRecent` cannot disagree on a row. */
function assertKnownStatus(row: { id: string; status: string }): SyncRunStatus {
  // The DB enum can drift from the domain union across migrations.
  if (!(SYNC_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError("DB_ERROR", {
      message: `Unknown sync run status '${row.status}' returned by the database`,
      userMessage: "Dữ liệu lần đồng bộ gần nhất không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id, status: row.status },
    });
  }
  return row.status as SyncRunStatus;
}

function parseCounts(row: { id: string; counts: unknown }): SyncRunCounts | null {
  if (row.counts === null || row.counts === undefined) return null;
  const parsed = countsSchema.safeParse(row.counts);
  if (!parsed.success) {
    throw new AppError("DB_ERROR", {
      message: "sync_run.counts does not match the current SyncRunCounts shape",
      userMessage: "Số liệu của lần đồng bộ gần nhất đã cũ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id, issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

function assertStartedAt(row: { id: string; startedAt: unknown }): Date {
  if (!(row.startedAt instanceof Date) || !Number.isFinite(row.startedAt.getTime())) {
    throw new AppError("DB_ERROR", {
      message: "sync_run.started_at is not a usable timestamp",
      userMessage: "Dữ liệu lần đồng bộ gần nhất không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id },
    });
  }
  return row.startedAt;
}

function readFinishedAt(finishedAt: unknown): Date | null {
  return finishedAt instanceof Date && Number.isFinite(finishedAt.getTime()) ? finishedAt : null;
}

function toSummary(row: SyncRunRow): SyncRunSummary {
  const status = assertKnownStatus(row);
  const counts = parseCounts(row);
  const startedAt = assertStartedAt(row);
  const finishedAt = readFinishedAt(row.finishedAt);

  // NULL is the shape of every run written before the column existed — it is a
  // legitimate answer, not a broken row (the screen falls back to `issues`).
  let issueGroups: SyncIssueGroup[] | null = null;
  if (row.issueGroups !== null && row.issueGroups !== undefined) {
    const parsed = issueGroupsSchema.safeParse(row.issueGroups);
    if (!parsed.success) {
      throw new AppError("DB_ERROR", {
        message: "sync_run.issue_groups does not match the current SyncIssueGroup shape",
        userMessage:
          "Thống kê lỗi của lần đồng bộ gần nhất không đọc được. Vui lòng chạy lại đồng bộ.",
        context: { sync_run_id: row.id, issues: parsed.error.issues },
      });
    }
    issueGroups = parsed.data;
  }

  const issues = issuesSchema.safeParse(row.issues ?? []);
  if (!issues.success) {
    throw new AppError("DB_ERROR", {
      message: "sync_run.issues does not match the current SyncIssue shape",
      userMessage: "Danh sách lỗi của lần đồng bộ gần nhất không đọc được. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id, issues: issues.error.issues },
    });
  }

  return {
    id: row.id,
    status,
    startedAt,
    finishedAt,
    counts,
    issues: issues.data,
    issueGroups,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}
export class DrizzleSyncRunRepo implements SyncRunRepo {
  constructor(
    private readonly db: Database,
    /** Only used to report a history row this class had to degrade. */
    private readonly logger?: Logger,
  ) {}

  async start(input: StartSyncRunInput): Promise<{ id: string }> {
    const scope = forTenant(this.db, input?.tenantId);
    try {
      const [row] = await scope.db
        .insert(syncRuns)
        .values(
          scope.row({
            status: "running" as const,
            startedAt: input.startedAt,
            source: {
              driveFolderId: input.source.driveFolderId,
              spreadsheetId: input.source.spreadsheetId,
              sheetName: input.source.sheetName,
            },
          }),
        )
        .returning({ id: syncRuns.id });

      if (!row) {
        throw new AppError("DB_ERROR", {
          message: "Insert of sync_run returned no row",
          context: { tenant_id: scope.tenantId, operation: "syncRun.start" },
        });
      }
      return { id: row.id };
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        operation: "syncRun.start",
      });
    }
  }

  async finish(input: FinishSyncRunInput): Promise<void> {
    const scope = forTenant(this.db, input?.tenantId);
    try {
      await scope.db
        .update(syncRuns)
        .set({
          status: input.status,
          finishedAt: input.finishedAt,
          counts: input.counts,
          issues: [...input.issues],
          issueGroups: [...input.issueGroups],
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
        })
        .where(scope.where(syncRuns, eq(syncRuns.id, input.syncRunId)));
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "syncRunId",
        sync_run_id: input?.syncRunId,
        operation: "syncRun.finish",
      });
    }
  }

  async findLatest(tenantId: TenantId): Promise<SyncRunSummary | null> {
    // Throws INVALID_INPUT on a malformed id before any SQL is built.
    const scope = forTenant(this.db, tenantId);

    let rows: SyncRunRow[];
    try {
      rows = await scope.db
        .select()
        .from(syncRuns)
        .where(scope.where(syncRuns))
        // createdAt breaks the tie when two runs share a startedAt instant.
        .orderBy(desc(syncRuns.startedAt), desc(syncRuns.createdAt))
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "syncRun.findLatest",
      });
    }

    const row = rows[0];
    return row ? toSummary(row) : null;
  }

  async listRecent(tenantId: TenantId, limit: number): Promise<readonly SyncRunListItem[]> {
    // Throws INVALID_INPUT on a malformed id before any SQL is built.
    const scope = forTenant(this.db, tenantId);

    // --- Edge case first: a bad limit must not reach the driver as `LIMIT NaN`.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AppError("INVALID_INPUT", {
        message: "listRecent requires a positive integer limit",
        userMessage: "Số lần chạy muốn xem không hợp lệ.",
        context: { tenant_id: scope.tenantId, limit, operation: "syncRun.listRecent" },
      });
    }

    // Only the columns the history rail paints: `issues`/`issue_groups` can be
    // megabytes per row and no line of that list would ever show them.
    let rows: Array<{
      id: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      counts: SyncRunCounts | null;
      errorCode: string | null;
    }>;
    try {
      rows = await scope.db
        .select({
          id: syncRuns.id,
          status: syncRuns.status,
          startedAt: syncRuns.startedAt,
          finishedAt: syncRuns.finishedAt,
          counts: syncRuns.counts,
          errorCode: syncRuns.errorCode,
        })
        .from(syncRuns)
        .where(scope.where(syncRuns))
        // Matches sync_run_tenant_started_idx; createdAt breaks an exact tie.
        .orderBy(desc(syncRuns.startedAt), desc(syncRuns.createdAt))
        .limit(limit);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "syncRun.listRecent",
      });
    }

    return rows.map((row) => ({
      id: row.id,
      status: assertKnownStatus(row),
      startedAt: assertStartedAt(row),
      finishedAt: readFinishedAt(row.finishedAt),
      issuesTotal: this.readIssuesTotal(row, scope.tenantId),
      errorCode: row.errorCode,
    }));
  }

  /**
   * `issuesTotal` for ONE history line. Unlike `findLatest`, a row whose
   * `counts` no longer matches the current shape must NOT fail the call: this
   * is the secondary list, and throwing here would take the funnel and the
   * issue table of the CURRENT run down with it. The row degrades to
   * `issuesTotal: null` — which the type already allows and the rail renders as
   * "không ghi được số vấn đề" — and the reason is logged with full context, so
   * nothing is swallowed (CLAUDE.md rules 5 + 6).
   */
  private readIssuesTotal(row: { id: string; counts: unknown }, tenantId: TenantId): number | null {
    // Null while a run is still going: it has written no counts yet.
    if (row.counts === null || row.counts === undefined) return null;

    try {
      return parseCounts(row)?.issuesTotal ?? null;
    } catch (error) {
      this.logger?.warn("Sync run history row has unreadable counts; reporting it as unknown", {
        error_code: "DB_ERROR",
        tenant_id: tenantId,
        sync_run_id: row.id,
        operation: "syncRun.listRecent",
        err: error,
      });
      return null;
    }
  }
}
