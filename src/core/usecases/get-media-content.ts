import { AppError } from "@/core/domain/errors";
import {
  verifyMediaUrlSignature,
  type MediaUrlRejection,
  type SignatureFn,
} from "@/core/domain/media-url";
import type { MediaKind } from "@/core/domain/media-file-name";
import type { MediaAsset } from "@/core/domain/product";
import type { DriveSource, MediaAssetLookup } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";

/**
 * E3.6 — serve one media asset's bytes to an UNAUTHENTICATED caller.
 *
 * Why it exists: create-post-batch demands an http(s) URL per photo because
 * Graph API fetches the image itself (`url` field of /photos), and Meta's
 * fetcher carries no session cookie. Drive's own links are either private (the
 * Service Account's) or need the file to be shared publicly — sharing 5,500
 * files with "anyone with the link" is the outcome this route avoids.
 *
 * Order of checks (edge cases first, CLAUDE.md rule 1):
 *   1. signature + expiry   -> UNAUTHORIZED, one code for every rejection so the
 *                              endpoint cannot be used as an oracle
 *   2. tenant-scoped lookup -> MEDIA_NOT_FOUND (also the isolation gate: the
 *                              Service Account can read EVERY tenant's folder)
 *   3. Drive download       -> MEDIA_NOT_FOUND / DRIVE_ERROR from the adapter
 *
 * The signature never appears in a log line, in an AppError context, or in the
 * response — only the rejection reason code does.
 */

export interface GetMediaContentInput {
  readonly tenantId: string;
  /** Drive file id — the media asset identity carried by post_job.media. */
  readonly mediaAssetId: string;
  /** Expiry from the query string; a numeric string is accepted. */
  readonly expiresAt: number | string;
  readonly signature: string;
}

export interface MediaContentResult {
  readonly driveFileId: string;
  readonly fileName: string;
  readonly productCode: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  /** Suggested `Cache-Control: private, max-age=...` for the route handler. */
  readonly cacheSeconds: number;
}

export interface GetMediaContentDeps {
  drive: DriveSource;
  /** E9 — where operator-uploaded bytes live; Drive holds nothing for those. */
  blobs: MediaBlobStore;
  mediaAssets: MediaAssetLookup;
  /** Same MAC the signer used — injected, so core never touches a secret. */
  sign: SignatureFn;
  clock: Clock;
  logger: Logger;
  /** Memory guard: the bytes are buffered. Default 25 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Meta re-fetches on its own schedule; a short cache is enough and safe. */
const CACHE_SECONDS = 300;
const FALLBACK_MIME = "application/octet-stream";

export function makeGetMediaContent(deps: GetMediaContentDeps) {
  return async function getMediaContent(
    input: GetMediaContentInput,
  ): Promise<MediaContentResult> {
    const nowMs = deps.clock.nowMs();
    const verdict = verifyMediaUrlSignature({
      tenantId: input?.tenantId,
      assetId: input?.mediaAssetId,
      expiresAt: input?.expiresAt,
      signature: input?.signature,
      nowMs,
      sign: deps.sign,
    });

    if (!verdict.ok) throw unauthorized(deps, input, verdict.reason);

    const { tenantId, assetId } = verdict.claims;
    const log = deps.logger.child({ tenant_id: tenantId });
    const maxBytes = positive(deps.maxBytes) ?? DEFAULT_MAX_BYTES;

    const asset = await deps.mediaAssets.findByDriveFileId(tenantId, assetId);
    if (!asset) {
      // Also the tenant-isolation verdict: a signature of another tenant lands
      // here because the row is scoped by tenant_id, not because of the MAC.
      log.warn("Signed media request for an asset this tenant does not have", {
        drive_file_id: assetId,
        error_code: "MEDIA_NOT_FOUND",
      });
      throw new AppError("MEDIA_NOT_FOUND", {
        message: "No synced media asset with this Drive file id for this tenant",
        userMessage: "Không tìm thấy ảnh này — có thể đã bị xoá trên Drive hoặc chưa đồng bộ.",
        context: { tenant_id: tenantId, drive_file_id: assetId },
      });
    }

    // Refuse before the download when the sync already knows the file is huge.
    if (typeof asset.sizeBytes === "number" && asset.sizeBytes > maxBytes) {
      throw tooLarge(tenantId, assetId, asset.sizeBytes, maxBytes);
    }

    // Mode A reads from Drive, mode B from the blob store (E9). Both end up as
    // the same bytes on the same signed URL, which is what lets an uploaded post
    // travel the existing publish path unchanged (brief section 8).
    const content =
      asset.origin === "upload"
        ? await readUploadedBlob(deps, { tenantId, assetId, asset, maxBytes })
        : await deps.drive.download({ tenantId, fileId: assetId, maxBytes });

    if (!content?.bytes || content.bytes.length === 0) {
      // Facebook would fail on a 0-byte body with an opaque Graph error; make
      // the cause visible here instead.
      throw new AppError(asset.origin === "upload" ? "MEDIA_NOT_FOUND" : "DRIVE_ERROR", {
        message: "Media source returned an empty body for an asset",
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
      throw tooLarge(tenantId, assetId, content.bytes.length, maxBytes);
    }

    const mimeType = pickMime(content.mimeType, asset.mimeType);
    log.info("Signed media request served", {
      drive_file_id: assetId,
      product_code: asset.productCode,
      file_name: asset.fileName,
      kind: asset.kind,
      mime_type: mimeType,
      bytes: content.bytes.length,
    });

    return {
      driveFileId: assetId,
      fileName: asset.fileName,
      productCode: asset.productCode,
      kind: asset.kind,
      mimeType,
      sizeBytes: content.bytes.length,
      bytes: content.bytes,
      cacheSeconds: CACHE_SECONDS,
    };
  };
}

export type GetMediaContent = ReturnType<typeof makeGetMediaContent>;

// --- helpers ----------------------------------------------------------------

/**
 * Reads the bytes of an uploaded asset.
 *
 * A row with `origin = 'upload'` and no storage key is a broken record, not a
 * reason to fall through to Drive: Drive has never heard of this id, so the
 * fallback would turn a clear "the upload is gone" into an opaque Drive 404.
 */
async function readUploadedBlob(
  deps: GetMediaContentDeps,
  input: { tenantId: string; assetId: string; asset: MediaAsset; maxBytes: number },
): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
  const { tenantId, assetId, asset, maxBytes } = input;

  if (!asset.storageKey) {
    deps.logger.error("Uploaded asset has no storage key", {
      tenant_id: tenantId,
      drive_file_id: assetId,
      file_name: asset.fileName,
      error_code: "MEDIA_NOT_FOUND",
      reason: "MISSING_STORAGE_KEY",
    });
    throw missingUpload(tenantId, assetId, "MISSING_STORAGE_KEY");
  }

  const blob = await deps.blobs.get({ tenantId, storageKey: asset.storageKey, maxBytes });
  if (!blob) {
    // The row outlived its bytes: the cleanup job raced the post, or the volume
    // was replaced. Say so plainly — this is the "vì sao bài này không lên?"
    // question business rule 5 exists for.
    deps.logger.error("Uploaded asset has a storage key but no bytes behind it", {
      tenant_id: tenantId,
      drive_file_id: assetId,
      file_name: asset.fileName,
      error_code: "MEDIA_NOT_FOUND",
      reason: "BLOB_MISSING",
    });
    throw missingUpload(tenantId, assetId, "BLOB_MISSING");
  }

  return blob;
}

function missingUpload(tenantId: string, assetId: string, reason: string): AppError {
  return new AppError("MEDIA_NOT_FOUND", {
    message: "Uploaded media asset has no readable bytes",
    userMessage: "File đã tải lên không còn nữa — hãy tải lại file cho bài này.",
    context: { tenant_id: tenantId, drive_file_id: assetId, origin: "upload", reason },
  });
}

/**
 * One error code for every rejection (expired, forged, malformed): the caller
 * gets 401 and no hint about WHICH check failed. The reason code stays in the
 * log/context — it is a constant, never derived from the submitted signature.
 */
function unauthorized(
  deps: GetMediaContentDeps,
  input: GetMediaContentInput | undefined,
  reason: MediaUrlRejection,
): AppError {
  const tenantId = typeof input?.tenantId === "string" ? input.tenantId : null;
  const assetId = typeof input?.mediaAssetId === "string" ? input.mediaAssetId : null;
  const context = {
    tenant_id: tenantId,
    drive_file_id: assetId,
    reason,
    error_code: "UNAUTHORIZED",
  };
  deps.logger.warn("Rejected a signed media request", context);
  return new AppError("UNAUTHORIZED", {
    message: `Signed media URL rejected: ${reason}`,
    userMessage: "Liên kết ảnh không hợp lệ hoặc đã hết hạn.",
    context,
  });
}

function tooLarge(
  tenantId: string,
  assetId: string,
  sizeBytes: number,
  maxBytes: number,
): AppError {
  return new AppError("DRIVE_ERROR", {
    message: "Media asset exceeds the size the media route will buffer",
    userMessage: "File ảnh quá lớn để phục vụ cho Facebook — cần giảm dung lượng file.",
    context: {
      tenant_id: tenantId,
      drive_file_id: assetId,
      size_bytes: sizeBytes,
      max_bytes: maxBytes,
      reason: "CONTENT_TOO_LARGE",
    },
  });
}

function pickMime(fromDrive: string | null, fromDb: string | null): string {
  const drive = clean(fromDrive);
  if (drive) return drive;
  const db = clean(fromDb);
  // 606 real files carry no extension (docs/05 1.3); octet-stream is the honest
  // answer, and the sync already flagged those assets as needing review.
  return db ?? FALLBACK_MIME;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
