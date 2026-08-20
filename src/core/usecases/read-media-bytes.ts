import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { DriveSource, MediaAssetLookup } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaByteCache } from "@/core/ports/media-byte-cache";
import type { PublishMediaBytes } from "@/core/ports/publisher";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E5 — read ONE media asset's bytes for an upload, cache first, source second.
 *
 * Why it exists: the publish path no longer hands Facebook a URL to fetch. Graph
 * downloads such a URL itself and gives up around 30s (error 324) — on a real
 * 10-photo post Drive answered between 1.3s and 99.9s per file and only 4 of 10
 * photos made it. Uploading the bytes ourselves put 10 of 10 on the Page,
 * because the side that waits is now the worker, and the worker may wait.
 *
 * Same order the media route uses (get-media-content), for the same reason:
 *   cache -> hit  : a local read, no Drive at all
 *   cache -> miss : Drive (or the blob store for E9 mode B), then write the
 *                   cache so the retry / the second channel / the preview screen
 *                   costs nothing.
 * The cache is an OPTIMISATION, never a precondition: a broken cache degrades to
 * "read the origin", it never fails a post.
 *
 * Unlike the media route, a failure here is FATAL for the post: there is nothing
 * to upload. The error keeps its own code so the caller can tell "this file is
 * gone" (MEDIA_NOT_FOUND, no point retrying) from "Drive hiccuped" (DRIVE_ERROR,
 * retryable) — see `retryable` in the context.
 */

/** Mirrors the media route's cap: one photo is buffered in memory at a time. */
export const DEFAULT_MEDIA_READ_MAX_BYTES = 25 * 1024 * 1024;

export interface ReadMediaBytesInput {
  readonly tenantId: TenantId;
  /** Asset identity — `PostJobMedia.driveFileId`. */
  readonly assetId: string;
  /** Carried into the logs so a slow read is traceable to its post. */
  readonly jobId?: string | null;
  readonly maxBytes?: number;
}

export interface ReadMediaBytesDeps {
  cache: MediaByteCache;
  drive: DriveSource;
  /** E9 mode B — where operator-uploaded bytes live; Drive holds nothing. */
  blobs: MediaBlobStore;
  /** Tenant-scoped: the Service Account can read EVERY tenant's folder. */
  mediaAssets: MediaAssetLookup;
  logger: Logger;
  maxBytes?: number;
}

export function makeReadMediaBytes(deps: ReadMediaBytesDeps) {
  return async function readMediaBytes(
    input: ReadMediaBytesInput,
  ): Promise<PublishMediaBytes> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ----------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const assetId = typeof input?.assetId === "string" ? input.assetId.trim() : "";
    if (!isTenantId(rawTenantId) || assetId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "readMediaBytes requires a tenant UUID and an asset id",
        userMessage: "Yêu cầu đọc file ảnh thiếu thông tin định danh — đã từ chối.",
        context: {
          tenant_id: rawTenantId || null,
          drive_file_id: assetId || null,
          reason: "INVALID_MEDIA_REQUEST",
          retryable: false,
        },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const maxBytes =
      positive(input?.maxBytes) ?? positive(deps.maxBytes) ?? DEFAULT_MEDIA_READ_MAX_BYTES;
    const jobId = str(input?.jobId);
    const log = deps.logger.child({
      tenant_id: tenantId,
      ...(jobId ? { job_id: jobId } : {}),
      component: "media-bytes",
    });

    const asset = await deps.mediaAssets.findByDriveFileId(tenantId, assetId);
    if (!asset) {
      // Also the tenant-isolation verdict: the row is scoped by tenant_id, so a
      // foreign asset id lands here instead of reaching Drive.
      log.error("Media asset not found for this tenant — nothing to upload", {
        drive_file_id: assetId,
        error_code: "MEDIA_NOT_FOUND",
        reason: "ASSET_NOT_IN_SNAPSHOT",
      });
      throw new AppError("MEDIA_NOT_FOUND", {
        message: "No synced media asset with this id for this tenant",
        userMessage: "Không tìm thấy ảnh này — có thể đã bị xoá trên Drive hoặc chưa đồng bộ.",
        context: {
          tenant_id: tenantId,
          drive_file_id: assetId,
          reason: "ASSET_NOT_IN_SNAPSHOT",
          // A deleted file will not come back inside a backoff window.
          retryable: false,
        },
      });
    }
    if (typeof asset.sizeBytes === "number" && asset.sizeBytes > maxBytes) {
      throw tooLarge(tenantId, assetId, asset.fileName, asset.sizeBytes, maxBytes);
    }

    // --- 1. Cache (mode A only — an uploaded file is already local) ---------
    const cacheable = asset.origin !== "upload";
    if (cacheable) {
      const cached = await readCache(deps, log, { tenantId, assetId, maxBytes });
      if (cached && cached.bytes.length > 0) {
        log.debug("Media bytes served from the cache", {
          drive_file_id: assetId,
          file_name: asset.fileName,
          bytes: cached.bytes.length,
          source: "cache",
        });
        return { bytes: cached.bytes, mimeType: pickMime(cached.mimeType, asset.mimeType) };
      }
    }

    // --- 2. The origin ------------------------------------------------------
    let content: PublishMediaBytes;
    if (asset.origin === "upload") {
      if (!asset.storageKey) {
        // A mode B row without a key is broken, not a reason to try Drive:
        // Drive has never heard of an `upload_<hex>` id.
        log.error("Uploaded asset has no storage key", {
          drive_file_id: assetId,
          file_name: asset.fileName,
          error_code: "MEDIA_NOT_FOUND",
          reason: "MISSING_STORAGE_KEY",
        });
        throw missingUpload(tenantId, assetId, "MISSING_STORAGE_KEY");
      }
      const blob = await deps.blobs.get({
        tenantId,
        storageKey: asset.storageKey,
        maxBytes,
      });
      if (!blob) {
        log.error("Uploaded asset has a storage key but no bytes behind it", {
          drive_file_id: assetId,
          file_name: asset.fileName,
          error_code: "MEDIA_NOT_FOUND",
          reason: "BLOB_MISSING",
        });
        throw missingUpload(tenantId, assetId, "BLOB_MISSING");
      }
      content = { bytes: blob.bytes, mimeType: blob.mimeType };
    } else {
      const downloaded = await deps.drive.download({ tenantId, fileId: assetId, maxBytes });
      content = { bytes: downloaded.bytes, mimeType: downloaded.mimeType };
    }

    if (!content.bytes || content.bytes.length === 0) {
      // Graph answers an empty part with an opaque error; name the cause here.
      throw new AppError(asset.origin === "upload" ? "MEDIA_NOT_FOUND" : "DRIVE_ERROR", {
        message: "Media source returned an empty body",
        userMessage:
          asset.origin === "upload"
            ? "File đã tải lên không còn đọc được — hãy tải lại file cho bài này."
            : "File ảnh trên Drive rỗng hoặc không tải được — cần kiểm tra lại file.",
        context: {
          tenant_id: tenantId,
          drive_file_id: assetId,
          file_name: asset.fileName,
          origin: asset.origin,
          reason: "EMPTY_CONTENT",
        },
      });
    }
    if (content.bytes.length > maxBytes) {
      throw tooLarge(tenantId, assetId, asset.fileName, content.bytes.length, maxBytes);
    }

    // --- 3. Fill the cache for the retry / the other channel / the preview --
    // After the size and emptiness gates: the cache must never hold bytes this
    // code would refuse to hand over.
    if (cacheable) {
      await writeCache(deps, log, {
        tenantId,
        assetId,
        bytes: content.bytes,
        mimeType: content.mimeType,
      });
    }

    log.debug("Media bytes read from the origin", {
      drive_file_id: assetId,
      file_name: asset.fileName,
      bytes: content.bytes.length,
      source: asset.origin === "upload" ? "blob_store" : "drive",
    });
    return { bytes: content.bytes, mimeType: pickMime(content.mimeType, asset.mimeType) };
  };
}

export type ReadMediaBytes = ReturnType<typeof makeReadMediaBytes>;

// --- helpers ----------------------------------------------------------------

/**
 * Cache read that CANNOT fail the post: a broken volume degrades to the origin.
 * Not swallowed — the failure is logged with tenant + asset, so a permanently
 * unreadable cache shows up as a warning on every post instead of as silence.
 */
async function readCache(
  deps: ReadMediaBytesDeps,
  log: Logger,
  input: { tenantId: TenantId; assetId: string; maxBytes: number },
): Promise<PublishMediaBytes | null> {
  try {
    return await deps.cache.get(input);
  } catch (error) {
    log.warn("Media cache read failed — falling back to the origin", {
      drive_file_id: input.assetId,
      reason: "CACHE_READ_FAILED",
      err: AppError.from(error, "INTERNAL", {
        tenant_id: input.tenantId,
        drive_file_id: input.assetId,
      }).toLogObject(),
    });
    return null;
  }
}

/** Same reasoning as the read: a full disk makes the NEXT post slow, not this one fail. */
async function writeCache(
  deps: ReadMediaBytesDeps,
  log: Logger,
  input: { tenantId: TenantId; assetId: string; bytes: Uint8Array; mimeType: string | null },
): Promise<void> {
  try {
    await deps.cache.put(input);
  } catch (error) {
    log.warn("Media cache write failed — the bytes are still being uploaded", {
      drive_file_id: input.assetId,
      bytes: input.bytes.length,
      reason: "CACHE_WRITE_FAILED",
      err: AppError.from(error, "INTERNAL", {
        tenant_id: input.tenantId,
        drive_file_id: input.assetId,
      }).toLogObject(),
    });
  }
}

function missingUpload(tenantId: TenantId, assetId: string, reason: string): AppError {
  return new AppError("MEDIA_NOT_FOUND", {
    message: "Uploaded media asset has no readable bytes",
    userMessage: "File đã tải lên không còn nữa — hãy tải lại file cho bài này.",
    context: {
      tenant_id: tenantId,
      drive_file_id: assetId,
      origin: "upload",
      reason,
      retryable: false,
    },
  });
}

function tooLarge(
  tenantId: TenantId,
  assetId: string,
  fileName: string,
  sizeBytes: number,
  maxBytes: number,
): AppError {
  return new AppError("DRIVE_ERROR", {
    message: "Media asset exceeds the byte budget of one upload",
    userMessage: "File ảnh quá lớn để tải lên Facebook — cần giảm dung lượng file.",
    context: {
      tenant_id: tenantId,
      drive_file_id: assetId,
      file_name: fileName,
      size_bytes: sizeBytes,
      max_bytes: maxBytes,
      reason: "CONTENT_TOO_LARGE",
      // A smaller file needs a human, not a backoff.
      retryable: false,
    },
  });
}

/** The origin's header wins; the synced row is the fallback (606 files have no extension). */
function pickMime(fromSource: string | null, fromDb: string | null): string | null {
  return clean(fromSource) ?? clean(fromDb);
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
