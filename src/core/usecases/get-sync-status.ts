import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type {
  SyncIssue,
  SyncIssueGroup,
  SyncRunCounts,
  SyncRunRepo,
  SyncRunStatus,
} from "@/core/ports/product-repo";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E2 — read model for the sync status panel: "when did we last read Drive/Sheet
 * and what did it skip?". Read-only: it never starts a sync.
 *
 * Dates leave as ISO-8601 strings so the transport layer has nothing to decide
 * (same convention as healthcheckTenant). A tenant that never synced is a
 * normal answer (`null`), not an error.
 */

/**
 * History rows returned alongside the latest run.
 *
 * SIX, not five, on purpose: `recentRuns` INCLUDES the run described by the rest
 * of this result, and the rail drops that one before rendering "5 lần chạy
 * trước". Asking for five would leave four rows on screen. Do not "fix" it to 5.
 */
export const DEFAULT_RECENT_RUNS = 6;
export const MAX_RECENT_RUNS = 20;

export interface GetSyncStatusInput {
  readonly tenantId: TenantId;
  /**
   * How many history rows to read. Integer 1..MAX_RECENT_RUNS; defaults to
   * DEFAULT_RECENT_RUNS (6, because the list includes the run being described).
   */
  readonly recentLimit?: number;
}

/** One row of the history rail — no issues, no groups (see SyncRunListItem). */
export interface RecentSyncRun {
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  /** ISO-8601. */
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Null when that run never wrote counts (still running, or crashed). */
  readonly issuesTotal: number | null;
  readonly errorCode: string | null;
}

export interface GetSyncStatusResult {
  readonly tenantId: TenantId;
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  /** ISO-8601. */
  readonly startedAt: string;
  /** ISO-8601; null while the run is still `running` or crashed mid-way. */
  readonly finishedAt: string | null;
  /** Null until the run finishes. `issuesTotal` there is the uncapped number. */
  readonly counts: SyncRunCounts | null;
  /** Capped list stored with the run — see `counts.issuesTruncated`. */
  readonly issues: readonly SyncIssue[];
  /**
   * Exact per-code counts. NULL for a run stored before the column existed —
   * the screen must fall back to counting `issues[]` instead of showing zero.
   */
  readonly issueGroups: readonly SyncIssueGroup[] | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Newest first, INCLUDING the run above. Empty only when nothing ran. */
  readonly recentRuns: readonly RecentSyncRun[];
}

export interface GetSyncStatusDeps {
  syncRuns: SyncRunRepo;
  logger: Logger;
}

export function makeGetSyncStatus(deps: GetSyncStatusDeps) {
  return async function getSyncStatus(
    input: GetSyncStatusInput,
  ): Promise<GetSyncStatusResult | null> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      // No logger.child: there is no trustworthy tenant_id to bind yet.
      deps.logger.warn("Sync status rejected: malformed tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: rawTenantId || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "tenantId must be a UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    // An out-of-range limit is a caller bug, not something to silently clamp:
    // clamping would hide a UI that asks for 500 rows every render.
    const recentLimit = input?.recentLimit ?? DEFAULT_RECENT_RUNS;
    if (!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > MAX_RECENT_RUNS) {
      deps.logger.warn("Sync status rejected: recentLimit out of range", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId,
        recent_limit: recentLimit,
      });
      throw new AppError("INVALID_INPUT", {
        message: `recentLimit must be an integer between 1 and ${MAX_RECENT_RUNS}`,
        userMessage: `Số lần chạy muốn xem phải là số nguyên từ 1 đến ${MAX_RECENT_RUNS}.`,
        context: { tenant_id: tenantId, recent_limit: recentLimit },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId });

    // Repo failures are already AppError('DB_ERROR') from the adapter — let them
    // propagate untouched; catching here would only blur the cause.
    const run = await deps.syncRuns.findLatest(tenantId);

    if (!run) {
      log.info("Sync status: tenant has never run a catalog sync");
      return null;
    }

    // Only worth a query once we know a run exists at all.
    const recent = await deps.syncRuns.listRecent(tenantId, recentLimit);

    // --- Happy path ---------------------------------------------------------
    log.debug("Sync status resolved", {
      job_id: run.id,
      sync_status: run.status,
      issues_stored: run.issues.length,
      issues_total: run.counts?.issuesTotal ?? null,
      issue_groups: run.issueGroups?.length ?? null,
      recent_runs: recent.length,
    });

    return {
      tenantId,
      syncRunId: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      counts: run.counts,
      issues: run.issues,
      issueGroups: run.issueGroups,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      recentRuns: recent.map((item) => ({
        syncRunId: item.id,
        status: item.status,
        startedAt: item.startedAt.toISOString(),
        finishedAt: item.finishedAt ? item.finishedAt.toISOString() : null,
        issuesTotal: item.issuesTotal,
        errorCode: item.errorCode,
      })),
    };
  };
}

export type GetSyncStatus = ReturnType<typeof makeGetSyncStatus>;
