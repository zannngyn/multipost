import { eq } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { FinishSyncRunInput, StartSyncRunInput, SyncRunRepo } from "@/core/ports/product-repo";

import type { Database } from "./client";
import { syncRuns } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * Sync-run history (E2). The row is written BEFORE the work starts so a crashed
 * process still leaves a `running` trace instead of nothing.
 */
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
}
