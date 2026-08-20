import { AppError } from "@/core/domain/errors";
import type { MediaAsset } from "@/core/domain/product";
import type { TenantId } from "@/core/domain/tenant-context";

import {
  readTenantMediaContent,
  type MediaContentResult,
  type MediaContentSourceDeps,
} from "./get-media-content";

/**
 * E3.6b — serve one media asset to a SIGNED-IN operator (the compose screen).
 *
 * NOT the same door as `getMediaContent`, and the difference is the whole point:
 *
 * | | `/api/media/[driveFileId]` | `/api/media/preview/[driveFileId]` |
 * |---|---|---|
 * | caller | Meta's fetcher, no cookie | the operator's browser |
 * | authorised by | HMAC in the query string (tier P) | session + membership (tier R) |
 * | tenant from | the signed claim | `requireTenant()` |
 *
 * Why a second door instead of putting the signed link in an `<img>`: a signed
 * URL is a BEARER TOKEN, and a bearer token in `src=` leaks into browser
 * history, into `Referer` and into any screenshot of the address bar — doc 10 §2
 * forbids exactly that. The session cookie the browser already carries is the
 * better credential here, so the preview uses it and mints nothing.
 *
 * IMAGES ONLY. A video is refused with MEDIA_NOT_FOUND (404), not 415:
 *   - the caller is a `<img>` tag, whose only two outcomes are "pixels" and
 *     "broken" — a 415 buys the UI nothing a 404 does not;
 *   - no new error code, so nothing has to change in the shared error table
 *     while three other agents are editing around it;
 *   - and it stays honest: there IS no preview image for this asset.
 * The log line carries `reason: "PREVIEW_KIND_UNSUPPORTED"` so "vì sao ô này
 * trống" is answerable without a debugger. Video previews (poster frame) are a
 * Phase 2 item, together with the rest of video posting.
 */

export interface GetMediaPreviewInput {
  /** Already authorised by `requireTenant()` — never a string off a request. */
  readonly tenantId: TenantId;
  /** `MediaAsset.driveFileId`: a Drive id, or `upload_<hex>` for mode B. */
  readonly mediaAssetId: string;
}

export type GetMediaPreviewDeps = MediaContentSourceDeps;

export function makeGetMediaPreview(deps: GetMediaPreviewDeps) {
  return async function getMediaPreview(
    input: GetMediaPreviewInput,
  ): Promise<MediaContentResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ----------------------
    const assetId = typeof input?.mediaAssetId === "string" ? input.mediaAssetId.trim() : "";
    if (assetId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "getMediaPreview requires a media asset id",
        userMessage: "Thiếu mã ảnh cần xem.",
        context: { tenant_id: input?.tenantId ?? null },
      });
    }

    const { result } = await readTenantMediaContent(deps, {
      tenantId: input.tenantId,
      assetId,
      surface: "preview",
      accept: (asset) => refuseNonImage(deps, input.tenantId, asset),
    });

    deps.logger.child({ tenant_id: input.tenantId }).info("Media preview served", {
      drive_file_id: result.driveFileId,
      product_code: result.productCode,
      file_name: result.fileName,
      mime_type: result.mimeType,
      bytes: result.sizeBytes,
    });

    return result;
  };
}

export type GetMediaPreview = ReturnType<typeof makeGetMediaPreview>;

/**
 * `asset.kind` is the sync's verdict, which already covers the 606 real files
 * with no extension at all (docs/05 §1.3 — those are recorded as images that
 * need review). Trusting it keeps one classifier in the system instead of
 * inventing a second one from the mime type here.
 */
function refuseNonImage(deps: GetMediaPreviewDeps, tenantId: TenantId, asset: MediaAsset): void {
  if (asset.kind === "image") return;

  deps.logger.child({ tenant_id: tenantId }).warn("Preview refused: the asset is not an image", {
    drive_file_id: asset.driveFileId,
    file_name: asset.fileName,
    kind: asset.kind,
    reason: "PREVIEW_KIND_UNSUPPORTED",
    error_code: "MEDIA_NOT_FOUND",
  });
  throw new AppError("MEDIA_NOT_FOUND", {
    message: `Preview is images only; this asset is a ${asset.kind}`,
    userMessage: "Chưa xem trước được video — hiện chỉ xem trước ảnh.",
    context: {
      tenant_id: tenantId,
      drive_file_id: asset.driveFileId,
      kind: asset.kind,
      reason: "PREVIEW_KIND_UNSUPPORTED",
    },
  });
}
