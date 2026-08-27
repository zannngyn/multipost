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
import type { MediaByteCache } from "@/core/ports/media-byte-cache";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

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
 *   3. cache, then Drive    -> MEDIA_NOT_FOUND / DRIVE_ERROR from the adapter
 *
 * Step 3 is READ-THROUGH since the 324 incident: Graph API fetches these URLs
 * itself and gives up around 30s, while Drive took 6.7s–99.9s per file on a real
 * 10-photo post (6 of 10 photos failed). A cache hit removes Drive from the path
 * entirely; a miss pays the download once and stores it for every later fetch —
 * Meta re-fetches per photo, per retry and per channel.
 *
 * The cache is an OPTIMISATION, never a precondition: a broken cache degrades to
 * the old behaviour (log + serve from Drive) and never turns into a failed
 * request. Mode B (uploaded) assets bypass it — their bytes are already local.
 *
 * The signature never appears in a log line, in an AppError context, or in the
 * response — only the rejection reason code does.
 */

export interface GetMediaContentInput {
  readonly tenantId: TenantId;
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
  /**
   * Set only for an uploaded asset when the blob store could sign a
   * short-lived URL. When present, `bytes` is EMPTY (`new Uint8Array(0)`) and
   * MUST be ignored — the route answers 302 with this as `Location` instead
   * of streaming. This covers the UI preview only; publish-post.ts uploads
   * photo bytes to Graph directly and never reaches this route (see the
   * module doc above and the note on `ReadTenantMediaInput.allowRedirect`).
   */
  readonly redirectUrl?: string | null;
}

/** Which path served the bytes; `bypass` = mode B, whose bytes are already local. */
export type MediaCacheOutcome = "hit" | "miss" | "bypass";

/**
 * Everything needed to turn (tenant, asset id) into bytes — WITHOUT deciding who
 * is allowed to ask. Shared by the two doors onto the same assets:
 *   - `getMediaContent`  — tier P, authorised by the HMAC in the URL (Meta);
 *   - `getMediaPreview`  — session + membership (the compose screen).
 * Neither may skip `findByDriveFileId(tenantId, …)`: the Service Account can
 * read EVERY tenant's folder, so the tenant-scoped row IS the isolation gate.
 */
export interface MediaContentSourceDeps {
  drive: DriveSource;
  /** E9 — where operator-uploaded bytes live; Drive holds nothing for those. */
  blobs: MediaBlobStore;
  /** Read-through cache in front of Drive — the fix for the Graph 324 timeouts. */
  cache: MediaByteCache;
  mediaAssets: MediaAssetLookup;
  logger: Logger;
  /** Memory guard: the bytes are buffered. Default 25 MiB. */
  maxBytes?: number;
}

export interface GetMediaContentDeps extends MediaContentSourceDeps {
  /** Same MAC the signer used — injected, so core never touches a secret. */
  sign: SignatureFn;
  clock: Clock;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Meta re-fetches on its own schedule; a short cache is enough and safe. */
const CACHE_SECONDS = 300;
const FALLBACK_MIME = "application/octet-stream";
/**
 * TTL for a signed download URL handed out as a redirect target. Short on
 * purpose: the URL itself is a bearer token (nothing else guards the object).
 */
export const MEDIA_REDIRECT_TTL_SECONDS = 300;

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

    // The claim tenant is a raw string (tier P, media-url.ts). The signature just
    // proved it equals the branded tenant this request came in with, so re-brand
    // from input rather than minting one off the verified-but-unbranded claim.
    const { assetId } = verdict.claims;
    const tenantId = normalizeTenantId(input.tenantId);

    const { result, asset, cacheOutcome } = await readTenantMediaContent(deps, {
      tenantId,
      assetId,
      surface: "signed_url",
      allowRedirect: true,
    });

    if (result.redirectUrl) {
      // No mime_type/bytes here: this call never read the blob, so those
      // fields on `result` are placeholders, not what the client will see.
      deps.logger.child({ tenant_id: tenantId }).debug("Serving an uploaded asset by redirect", {
        drive_file_id: assetId,
        product_code: asset.productCode,
        file_name: asset.fileName,
        // Never log redirectUrl — it is a short-lived bearer token.
      });
      return result;
    }

    deps.logger.child({ tenant_id: tenantId }).info("Signed media request served", {
      drive_file_id: assetId,
      product_code: asset.productCode,
      file_name: asset.fileName,
      kind: asset.kind,
      mime_type: result.mimeType,
      bytes: result.sizeBytes,
      // "vì sao bài này không lên": a run of misses means every Meta fetch is
      // paying the Drive latency that caused the 324 timeouts.
      cache: cacheOutcome,
    });

    return result;
  };
}

export type GetMediaContent = ReturnType<typeof makeGetMediaContent>;

export interface ReadTenantMediaInput {
  readonly tenantId: TenantId;
  readonly assetId: string;
  /** Names the door in the log line, e.g. `signed_url` / `preview`. */
  readonly surface: string;
  /**
   * Policy check run right after the tenant-scoped lookup and BEFORE a single
   * byte is fetched — throw to refuse (the preview uses it to turn a video
   * away). Keeps "who may see what" in the caller instead of leaking it here.
   */
  readonly accept?: (asset: MediaAsset) => void;
  /**
   * Opt-in, and OFF by default. Only `getMediaContent` (tier P, the public
   * signed bridge) sets this — a signed download URL is a bearer token, and
   * `getMediaPreview` (tier R) hands bytes to the operator's own `<img>` tag,
   * where putting a bearer token in `src=` would leak it into browser
   * history and `Referer` (doc 10 §2). Preview must always stream.
   */
  readonly allowRedirect?: boolean;
}

export interface TenantMediaContent {
  readonly result: MediaContentResult;
  readonly asset: MediaAsset;
  readonly cacheOutcome: MediaCacheOutcome;
}

/**
 * (tenant, asset id) -> bytes. AUTHORISATION HAS ALREADY HAPPENED when this
 * runs — the signature for tier P, the membership for the preview — so the one
 * safety property it still owns is the tenant-scoped lookup below.
 *
 * It deliberately does NOT log the success line: the two callers describe the
 * same bytes to different readers, and one shared half-truthful message would
 * be worse than two accurate ones.
 */
export async function readTenantMediaContent(
  deps: MediaContentSourceDeps,
  input: ReadTenantMediaInput,
): Promise<TenantMediaContent> {
  const { tenantId, assetId } = input;
  const log = deps.logger.child({ tenant_id: tenantId });
  const maxBytes = positive(deps.maxBytes) ?? DEFAULT_MAX_BYTES;

  const asset = await deps.mediaAssets.findByDriveFileId(tenantId, assetId);
  if (!asset) {
    // Also the tenant-isolation verdict: an asset of ANOTHER tenant lands here
    // because the row is scoped by tenant_id — not because of the MAC, and not
    // because of the membership either.
    log.warn("Media request for an asset this tenant does not have", {
      drive_file_id: assetId,
      surface: input.surface,
      error_code: "MEDIA_NOT_FOUND",
    });
    throw new AppError("MEDIA_NOT_FOUND", {
      message: "No synced media asset with this Drive file id for this tenant",
      userMessage: "Không tìm thấy ảnh này — có thể đã bị xoá trên Drive hoặc chưa đồng bộ.",
      context: { tenant_id: tenantId, drive_file_id: assetId, surface: input.surface },
    });
  }

  // Before the download: refusing a video costs one DB read, not a 90s Drive
  // transfer that is thrown away.
  input.accept?.(asset);

  // Refuse before the download when the sync already knows the file is huge.
  if (typeof asset.sizeBytes === "number" && asset.sizeBytes > maxBytes) {
    throw tooLarge(tenantId, assetId, asset.sizeBytes, maxBytes);
  }

  // Mode A reads from the cache and falls back to Drive; mode B reads the blob
  // store (E9). Both end up as the same bytes on the same signed URL, which is
  // what lets an uploaded post travel the existing publish path unchanged
  // (brief section 8).
  let cacheOutcome: MediaCacheOutcome = "bypass";
  let content: MediaBytes;

  if (asset.origin === "upload") {
    // Signature verification already ran (top of getMediaContent, before this
    // function is ever reached) — only a request that already passed it can
    // get a signed download URL out of this branch.
    if (input.allowRedirect && asset.storageKey) {
      const redirectUrl = await deps.blobs.createDownloadUrl({
        tenantId,
        storageKey: asset.storageKey,
        expiresInSeconds: MEDIA_REDIRECT_TTL_SECONDS,
      });
      // Null means "this store cannot sign" (local dev) — fall through to the
      // normal blob read below. A real signing failure is not swallowed here:
      // it propagates like any other adapter error.
      if (redirectUrl) {
        return {
          asset,
          cacheOutcome,
          result: {
            driveFileId: assetId,
            fileName: asset.fileName,
            productCode: asset.productCode,
            kind: asset.kind,
            mimeType: pickMime(null, asset.mimeType),
            sizeBytes: asset.sizeBytes ?? 0,
            bytes: new Uint8Array(0),
            cacheSeconds: CACHE_SECONDS,
            redirectUrl,
          },
        };
      }
    }
    content = await readUploadedBlob(deps, { tenantId, assetId, asset, maxBytes });
  } else {
    const cached = await readCache(deps, { tenantId, assetId, maxBytes });
    if (cached) {
      cacheOutcome = "hit";
      content = cached;
    } else {
      cacheOutcome = "miss";
      content = await deps.drive.download({ tenantId, fileId: assetId, maxBytes });
    }
  }

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

  // Written only after the size/emptiness gates: a cache must never hold bytes
  // this route would refuse to serve.
  if (cacheOutcome === "miss") {
    await writeCache(deps, {
      tenantId,
      assetId,
      bytes: content.bytes,
      mimeType: content.mimeType,
    });
  }

  return {
    asset,
    cacheOutcome,
    result: {
      driveFileId: assetId,
      fileName: asset.fileName,
      productCode: asset.productCode,
      kind: asset.kind,
      mimeType: pickMime(content.mimeType, asset.mimeType),
      sizeBytes: content.bytes.length,
      bytes: content.bytes,
      cacheSeconds: CACHE_SECONDS,
    },
  };
}

// --- helpers ----------------------------------------------------------------

/** What every source (cache, Drive, blob store) boils down to here. */
interface MediaBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string | null;
}

/**
 * Cache read that CANNOT fail the request.
 *
 * A broken cache (unreadable volume, wrong permissions) must degrade to the
 * behaviour this route had before it existed — slow, but serving the picture.
 * The error is not swallowed: it is logged with tenant + asset and the outcome
 * is recorded as a miss, so a permanently broken volume shows up as a warn on
 * every request rather than as silence.
 */
async function readCache(
  deps: MediaContentSourceDeps,
  input: { tenantId: TenantId; assetId: string; maxBytes: number },
): Promise<MediaBytes | null> {
  try {
    return await deps.cache.get(input);
  } catch (error) {
    deps.logger.warn("Media cache read failed — falling back to Drive", {
      tenant_id: input.tenantId,
      drive_file_id: input.assetId,
      reason: "CACHE_READ_FAILED",
      err: AppError.from(error, "INTERNAL").toLogObject(),
    });
    return null;
  }
}

/**
 * Cache write that CANNOT fail the request either — same reasoning as the read,
 * and more pressing: the caller is Meta's fetcher waiting on a photo it will
 * abandon after ~30s. A full disk means the next fetch is slow, not that this
 * one fails.
 */
async function writeCache(
  deps: MediaContentSourceDeps,
  input: { tenantId: TenantId; assetId: string; bytes: Uint8Array; mimeType: string | null },
): Promise<void> {
  try {
    await deps.cache.put(input);
  } catch (error) {
    deps.logger.warn("Media cache write failed — the bytes were served anyway", {
      tenant_id: input.tenantId,
      drive_file_id: input.assetId,
      bytes: input.bytes.length,
      reason: "CACHE_WRITE_FAILED",
      err: AppError.from(error, "INTERNAL").toLogObject(),
    });
  }
}

/**
 * Reads the bytes of an uploaded asset.
 *
 * A row with `origin = 'upload'` and no storage key is a broken record, not a
 * reason to fall through to Drive: Drive has never heard of this id, so the
 * fallback would turn a clear "the upload is gone" into an opaque Drive 404.
 */
async function readUploadedBlob(
  deps: MediaContentSourceDeps,
  input: { tenantId: TenantId; assetId: string; asset: MediaAsset; maxBytes: number },
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

function missingUpload(tenantId: TenantId, assetId: string, reason: string): AppError {
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
  tenantId: TenantId,
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
