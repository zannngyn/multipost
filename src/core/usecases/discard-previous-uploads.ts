import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo } from "@/core/ports/product-repo";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Clears the previous, still-unposted upload attempt for a product code.
 * Shared by both intake paths (`upload-media.ts`, the deprecated direct-body
 * upload, and `confirm-upload.ts`, the presigned-ticket path) — same table,
 * same rule: `sequence` numbers an album from 1 on every call, so leaving an
 * earlier attempt behind would collide with the new one and compose would
 * return a jumbled album containing bytes the operator already replaced.
 *
 * Only UNREFERENCED uploads go: once a post job carries an asset, its row
 * must survive or the scheduled post cannot resolve its media URL.
 *
 * Failures here are logged and swallowed on purpose: the operator asked to
 * upload files, and refusing that because some old bytes could not be deleted
 * would be the wrong trade. The hourly sweep (E9.4) picks up whatever is left.
 * These rows are already-promoted uploads (they made it into `media_asset` on
 * an earlier confirm), so their bytes live in the SERVING area — `delete` is
 * the correct call here, never `deleteStaging`.
 */
export interface DiscardPreviousUploadsDeps {
  blobs: MediaBlobStore;
  media: MediaRepo;
}

export async function discardPreviousUploads(
  deps: DiscardPreviousUploadsDeps,
  input: { tenantId: TenantId; productCode: string; log: Logger },
): Promise<void> {
  const { tenantId, productCode, log } = input;

  let previous: readonly { assetId: string; storageKey: string }[];
  try {
    previous = await deps.media.listUnreferencedUploadsForCode(tenantId, productCode);
  } catch (error) {
    log.error("Could not list the previous uploads to replace", {
      ...AppError.from(error, "DB_ERROR", { reason: "LIST_PREVIOUS_UPLOADS_FAILED" }).toLogObject(),
    });
    return;
  }

  if (previous.length === 0) return;

  for (const item of previous) {
    if (!item.storageKey) continue;
    try {
      await deps.blobs.delete({ tenantId, storageKey: item.storageKey });
    } catch (error) {
      log.warn("Could not remove the bytes of a replaced upload", {
        ...AppError.from(error, "INTERNAL", { reason: "REPLACED_BLOB_DELETE_FAILED" }).toLogObject(),
        drive_file_id: item.assetId,
      });
    }
  }

  try {
    const removed = await deps.media.deleteUploads(
      tenantId,
      previous.map((item) => item.assetId),
    );
    log.info("Replaced the previous upload attempt for this code", { removed });
  } catch (error) {
    log.error("Could not remove the rows of a replaced upload", {
      ...AppError.from(error, "DB_ERROR", { reason: "REPLACED_ROW_DELETE_FAILED" }).toLogObject(),
    });
  }
}
