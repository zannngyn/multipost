import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import {
  SYNC_RUN_STATUSES,
  type FinishSyncRunInput,
  type StartSyncRunInput,
  type SyncIssue,
  type SyncRunCounts,
  type SyncRunRepo,
  type SyncRunStatus,
  type SyncRunSummary,
} from "@/core/ports/product-repo";

import type { Database } from "./client";
import { syncRuns, type SyncRunRow } from "./schema";
import { forTenant } from "./tenant-scope";

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

const issuesSchema: z.ZodType<SyncIssue[]> = z.array(
  z.object({
    errorCode: z.string(),
    reason: z.string(),
    ref: z.string(),
    detail: z.string(),
  }),
);

function toSummary(row: SyncRunRow): SyncRunSummary {
  // The DB enum can drift from the domain union across migrations.
  if (!(SYNC_RUN_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError("DB_ERROR", {
      message: `Unknown sync run status '${row.status}' returned by the database`,
      userMessage: "Dữ liệu lần đồng bộ gần nhất không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id, status: row.status },
    });
  }

  const counts = row.counts === null ? null : countsSchema.safeParse(row.counts);
  if (counts && !counts.success) {
    throw new AppError("DB_ERROR", {
      message: "sync_run.counts does not match the current SyncRunCounts shape",
      userMessage: "Số liệu của lần đồng bộ gần nhất đã cũ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id, issues: counts.error.issues },
    });
  }

  if (!(row.startedAt instanceof Date) || !Number.isFinite(row.startedAt.getTime())) {
    throw new AppError("DB_ERROR", {
      message: "sync_run.started_at is not a usable timestamp",
      userMessage: "Dữ liệu lần đồng bộ gần nhất không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { sync_run_id: row.id },
    });
  }

  const finishedAt =
    row.finishedAt instanceof Date && Number.isFinite(row.finishedAt.getTime())
      ? row.finishedAt
      : null;

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
    status: row.status as SyncRunStatus,
    startedAt: row.startedAt,
    finishedAt,
    counts: counts ? counts.data : null,
    issues: issues.data,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}
export class DrizzleSyncRunRepo implements SyncRunRepo {
  constructor(private readonly db: Database) {}

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
      throw AppError.from(error, "DB_ERROR", {
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
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
        })
        .where(scope.where(syncRuns, eq(syncRuns.id, input.syncRunId)));
    } catch (error) {
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        sync_run_id: input?.syncRunId,
        operation: "syncRun.finish",
      });
    }
  }

  async findLatest(tenantId: string): Promise<SyncRunSummary | null> {
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
      throw AppError.from(error, "DB_ERROR", {
        tenant_id: scope.tenantId,
        operation: "syncRun.findLatest",
      });
    }

    const row = rows[0];
    return row ? toSummary(row) : null;
  }
}
