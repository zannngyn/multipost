import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

/**
 * E9.4 — remove uploaded files nobody ever posted.
 *
 * Mode B writes bytes the moment an operator drops a file into the wizard, and
 * a wizard that is abandoned leaves them behind. Without this sweep the volume
 * grows forever with files no screen will ever show again.
 *
 * Also sweeps expired presigned-upload TICKETS (Task 8): a ticket the browser
 * never confirmed leaves bytes sitting in the STAGING area forever with a
 * ticket row past its expiry as the only witness. Same two rules apply, with
 * one addition: an expired ticket's bytes were never promoted, so removing
 * them is `blobs.deleteStaging`, never `blobs.delete` (which targets the
 * SERVING area and would silently no-op, leaking the object).
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
  /** Expired presigned-upload tickets found this pass (Task 8). */
  readonly ticketsScanned: number;
  /** Expired ticket rows removed this pass, after their staged bytes were gone. */
  readonly ticketsRemoved: number;
}

export interface CleanupUploadsDeps {
  media: MediaRepo;
  blobs: MediaBlobStore;
  tickets: UploadTicketRepo;
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

    // --- Bytes first --------------------------------------------------------
    let blobsRemoved = 0;
    let failed = 0;
    const deletable = new Map<TenantId, string[]>();

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

    // --- Expired presigned-upload tickets (Task 8) ---------------------------
    // Bytes first, row second — same rule as the asset sweep above: a ticket
    // row deleted before its staged bytes leaves an object nothing can ever
    // name again. An expired ticket's bytes were never confirmed, so they were
    // never promoted — they still live in the STAGING area, never the serving
    // one, so this MUST call `deleteStaging`, not `delete`.
    let expired: readonly UploadTicket[] = [];
    try {
      expired = await deps.tickets.listExpired({ now: deps.clock.now(), limit });
    } catch (error) {
      const appError = AppError.from(error, "DB_ERROR", { reason: "LIST_EXPIRED_TICKETS_FAILED" });
      log.error("Could not list expired upload tickets", appError.toLogObject());
    }

    const ticketsScanned = expired.length;
    const ticketDeletable = new Map<TenantId, string[]>();

    for (const ticket of expired) {
      try {
        await deps.blobs.deleteStaging({ tenantId: ticket.tenantId, storageKey: ticket.storageKey });
        addTicketDeletable(ticketDeletable, ticket);
      } catch (error) {
        // A busy store or a locked object is a reason to try again next hour,
        // not a reason to drop the row and lose the only handle on the bytes.
        failed += 1;
        const appError = AppError.from(error, "INTERNAL", {
          reason: "EXPIRED_TICKET_BLOB_DELETE_FAILED",
        });
        log.warn("Could not remove the staged bytes of an expired ticket", {
          ...appError.toLogObject(),
          tenant_id: ticket.tenantId,
          asset_id: ticket.assetId,
        });
      }
    }

    let ticketsRemoved = 0;
    for (const [tenantId, assetIds] of ticketDeletable) {
      try {
        ticketsRemoved += await deps.tickets.deleteMany(tenantId, assetIds);
      } catch (error) {
        failed += assetIds.length;
        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId,
          reason: "EXPIRED_TICKET_ROW_DELETE_FAILED",
          count: assetIds.length,
        });
        log.error("Could not remove expired ticket rows", appError.toLogObject());
      }
    }

    log.info("Upload cleanup pass finished", {
      scanned: orphans.length,
      blobs_removed: blobsRemoved,
      rows_removed: rowsRemoved,
      tickets_scanned: ticketsScanned,
      tickets_removed: ticketsRemoved,
      failed,
      ttl_hours: ttlHours,
    });

    return {
      scanned: orphans.length,
      blobsRemoved,
      rowsRemoved,
      failed,
      ticketsScanned,
      ticketsRemoved,
    };
  };
}

export type CleanupUploads = ReturnType<typeof makeCleanupUploads>;

// --- helpers ----------------------------------------------------------------

function addDeletable(map: Map<TenantId, string[]>, orphan: OrphanedUpload): void {
  const existing = map.get(orphan.tenantId);
  if (existing) existing.push(orphan.assetId);
  else map.set(orphan.tenantId, [orphan.assetId]);
}

function addTicketDeletable(map: Map<TenantId, string[]>, ticket: UploadTicket): void {
  const existing = map.get(ticket.tenantId);
  if (existing) existing.push(ticket.assetId);
  else map.set(ticket.tenantId, [ticket.assetId]);
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
