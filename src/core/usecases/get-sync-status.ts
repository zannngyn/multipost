import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type {
  SyncIssue,
  SyncRunCounts,
  SyncRunRepo,
  SyncRunStatus,
} from "@/core/ports/product-repo";

/**
 * E2 — read model for the sync status panel: "when did we last read Drive/Sheet
 * and what did it skip?". Read-only: it never starts a sync.
 *
 * Dates leave as ISO-8601 strings so the transport layer has nothing to decide
 * (same convention as healthcheckTenant). A tenant that never synced is a
 * normal answer (`null`), not an error.
 */

export interface GetSyncStatusInput {
  readonly tenantId: string;
}

export interface GetSyncStatusResult {
  readonly tenantId: string;
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
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
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
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(tenantId)) {
      // No logger.child: there is no trustworthy tenant_id to bind yet.
      deps.logger.warn("Sync status rejected: malformed tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "tenantId must be a UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: tenantId || null },
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

    // --- Happy path ---------------------------------------------------------
    log.debug("Sync status resolved", {
      job_id: run.id,
      sync_status: run.status,
      issues_stored: run.issues.length,
      issues_total: run.counts?.issuesTotal ?? null,
    });

    return {
      tenantId,
      syncRunId: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      counts: run.counts,
      issues: run.issues,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
    };
  };
}

export type GetSyncStatus = ReturnType<typeof makeGetSyncStatus>;
