import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";

/**
 * E9.4 — remove uploaded files nobody ever posted.
 *
 * Mode B writes bytes the moment an operator drops a file into the wizard, and
 * a wizard that is abandoned leaves them behind. Without this sweep the volume
 * grows forever with files no screen will ever show again.
 *
 * Two rules shape it:
 *   1. bytes first, row second. The sweep finds orphans BY ROW, so a row
 *      deleted before its bytes leaves a file nothing can ever name again.
 *   2. one failure does not stop the pass. A busy disk or a locked row is a
 *      reason to try again next hour, not to leave the rest of the sweep undone
 *      (business rule 6 in spirit: one item failing must not stop the others).
 */

/** Matches UPLOAD_ORPHAN_TTL_HOURS; the caller normally passes the configured one. */
export const DEFAULT_ORPHAN_TTL_HOURS = 24;
/** Rows per pass. Small on purpose: the sweep is a background chore. */
export const DEFAULT_CLEANUP_LIMIT = 200;

export interface CleanupUploadsInput {
  /** How old an unreferenced upload must be before it may be removed. */
  readonly ttlHours?: number;
  readonly limit?: number;
}

export interface CleanupUploadsResult {
  readonly scanned: number;
  readonly blobsRemoved: number;
  readonly rowsRemoved: number;
  /** Items left for the next pass because something failed. */
  readonly failed: number;
}

export interface CleanupUploadsDeps {
  media: MediaRepo;
  blobs: MediaBlobStore;
  clock: Clock;
  logger: Logger;
}

export function makeCleanupUploads(deps: CleanupUploadsDeps) {
  return async function cleanupUploads(
    input: CleanupUploadsInput = {},
  ): Promise<CleanupUploadsResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const ttlHours = positive(input?.ttlHours) ?? DEFAULT_ORPHAN_TTL_HOURS;
    const limit = positiveInt(input?.limit) ?? DEFAULT_CLEANUP_LIMIT;

    const log = deps.logger.child({ component: "upload-cleanup" });
    const olderThan = new Date(deps.clock.nowMs() - ttlHours * 60 * 60 * 1000);

    const orphans = await deps.media.listOrphanedUploads({ olderThan, limit });
    if (orphans.length === 0) {
      return { scanned: 0, blobsRemoved: 0, rowsRemoved: 0, failed: 0 };
    }

    // --- Bytes first --------------------------------------------------------
    let blobsRemoved = 0;
    let failed = 0;
    const deletable = new Map<string, string[]>();

    for (const orphan of orphans) {
      if (!orphan.storageKey) {
        // Nothing to remove; the row is still garbage and may go.
        addDeletable(deletable, orphan);
        continue;
      }

      try {
        const removed = await deps.blobs.delete({
          tenantId: orphan.tenantId,
          storageKey: orphan.storageKey,
        });
        if (removed) blobsRemoved += 1;
        addDeletable(deletable, orphan);
      } catch (error) {
        // Keep the row: it is the only handle left on this file.
        failed += 1;
        const appError = AppError.from(error, "INTERNAL", {
          tenant_id: orphan.tenantId,
          drive_file_id: orphan.assetId,
          file_name: orphan.fileName,
          reason: "BLOB_DELETE_FAILED",
        });
        log.error("Cleanup could not remove an uploaded file", appError.toLogObject());
      }
    }

    // --- Rows second, grouped per tenant ------------------------------------
    let rowsRemoved = 0;
    for (const [tenantId, assetIds] of deletable) {
      try {
        rowsRemoved += await deps.media.deleteUploads(tenantId, assetIds);
      } catch (error) {
        failed += assetIds.length;
        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId,
          reason: "UPLOAD_ROW_DELETE_FAILED",
          count: assetIds.length,
        });
        log.error("Cleanup could not remove uploaded asset rows", appError.toLogObject());
      }
    }

    log.info("Upload cleanup pass finished", {
      scanned: orphans.length,
      blobs_removed: blobsRemoved,
      rows_removed: rowsRemoved,
      failed,
      ttl_hours: ttlHours,
    });

    return { scanned: orphans.length, blobsRemoved, rowsRemoved, failed };
  };
}

export type CleanupUploads = ReturnType<typeof makeCleanupUploads>;

// --- helpers ----------------------------------------------------------------

function addDeletable(map: Map<string, string[]>, orphan: OrphanedUpload): void {
  const existing = map.get(orphan.tenantId);
  if (existing) existing.push(orphan.assetId);
  else map.set(orphan.tenantId, [orphan.assetId]);
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
