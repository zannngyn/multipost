import { AppError } from "@/core/domain/errors";
import type { MediaKind } from "@/core/domain/media-file-name";
import { sniffMediaMimeType } from "@/core/domain/media-sniff";
import type { MediaAsset } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import {
  applyUploadOrder,
  validateUpload,
  type UploadRejectionReason,
} from "@/core/domain/uploaded-media";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo } from "@/core/ports/product-repo";

/**
 * E9.1 — take the files an operator supplied, keep the ones that can actually
 * be published, and register them as media assets of a product code.
 *
 * Everything downstream is unchanged by design (brief section 8: both modes
 * share stock, AI and publishing). Two details do that work:
 *   - the rows land in `media_asset` with `origin = 'upload'`, so composing can
 *     ask for them exactly the way it asks for Drive assets;
 *   - `sequence` is written as the position in the ARRANGED order, so the
 *     existing album sort in compose-post reproduces the drag-and-drop result
 *     without knowing mode B exists.
 *
 * A bad file is reported, not thrown (business rule 5): dragging six photos and
 * getting "upload failed" tells the operator nothing. A call with NOTHING usable
 * does throw — there is no post to go on with.
 */

export interface UploadedFile {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface UploadMediaInput {
  readonly tenantId: string;
  readonly productCode: string;
  readonly files: readonly UploadedFile[];
  /** Indexes into `files`; index 0 becomes the cover. Absent = keep as sent. */
  readonly order?: readonly number[];
  /**
   * Sizes as declared by the transport, when they are known before the bytes
   * are read. Lets an oversized file be refused without buffering it.
   */
  readonly declaredSizes?: readonly number[];
}

export interface UploadRejectionReport {
  readonly fileName: string;
  readonly reason: UploadRejectionReason;
  readonly userMessage: string;
}

export interface UploadMediaResult {
  readonly accepted: readonly MediaAsset[];
  readonly rejected: readonly UploadRejectionReport[];
}

export interface UploadMediaDeps {
  blobs: MediaBlobStore;
  media: MediaRepo;
  logger: Logger;
  /** Injected so the id is deterministic under test. Must be path-safe. */
  newAssetId: () => string;
}

export function makeUploadMedia(deps: UploadMediaDeps) {
  return async function uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";

    if (!isTenantId(tenantId) || productCode.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "uploadMedia requires a tenant UUID and a product code",
        userMessage: "Thiếu mã sản phẩm cho các file vừa tải lên.",
        context: { tenant_id: tenantId || null, product_code: productCode || null },
      });
    }

    const files = Array.isArray(input?.files) ? input.files : [];
    // Throws on an empty album or one above the per-post cap, and validates the
    // arrangement is a real permutation.
    const arranged = applyUploadOrder(files, input?.order);
    const sizes = arrangeSizes(input, files, arranged);

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });

    // --- Per-file gate ------------------------------------------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: Array<{ file: UploadedFile; kind: MediaKind; mimeType: string }> = [];

    for (const [index, candidate] of arranged.entries()) {
      const sizeBytes = sizes[index];
      const verdict = validateUpload({
        fileName: candidate?.fileName,
        mimeType: candidate?.mimeType,
        sizeBytes,
      });

      if (!verdict.ok) {
        log.warn("Upload rejected a file", {
          error_code: "INVALID_INPUT",
          reason: verdict.rejection.reason,
          file_name: candidate?.fileName ?? null,
          size_bytes: sizeBytes,
        });
        rejected.push({
          fileName: typeof candidate?.fileName === "string" ? candidate.fileName : "",
          reason: verdict.rejection.reason,
          userMessage: verdict.rejection.userMessage,
        });
        continue;
      }

      // The declared type got the file this far; the CONTENT decides whether it
      // is stored. `File.type` and the extension are both attacker-controlled,
      // and these bytes end up behind a public URL (CLAUDE.md rule 2).
      const actual = sniffMediaMimeType(candidate.bytes);
      if (!actual || actual !== verdict.mimeType) {
        log.warn("Upload rejected a file whose content does not match its declared type", {
          error_code: "INVALID_INPUT",
          reason: "CONTENT_TYPE_MISMATCH",
          file_name: candidate.fileName,
          declared_mime: verdict.mimeType,
          sniffed_mime: actual,
        });
        rejected.push({
          fileName: candidate.fileName,
          reason: "UNSUPPORTED_TYPE",
          userMessage: `Nội dung file "${candidate.fileName}" không khớp định dạng khai báo — file bị từ chối.`,
        });
        continue;
      }

      usable.push({ file: candidate, kind: verdict.kind, mimeType: actual });
    }

    if (usable.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Every uploaded file was refused",
        userMessage: `Không nhận được file nào: ${rejected.map((item) => item.userMessage).join(" ")}`,
        context: { tenant_id: tenantId, product_code: productCode, refused: rejected.length },
      });
    }

    assertOneAlbumKind(usable, { tenantId, productCode });

    // --- Store, then register ----------------------------------------------
    const accepted: MediaAsset[] = [];

    for (const [index, item] of usable.entries()) {
      const assetId = deps.newAssetId();
      let storageKey: string;
      let sizeBytes: number;

      try {
        const stored = await deps.blobs.put({
          tenantId,
          assetId,
          bytes: item.file.bytes,
          mimeType: item.mimeType,
          kind: item.kind,
        });
        storageKey = stored.storageKey;
        sizeBytes = stored.sizeBytes;
      } catch (error) {
        const appError = AppError.from(error, "INTERNAL", {
          tenant_id: tenantId,
          product_code: productCode,
          asset_id: assetId,
          file_name: item.file.fileName,
          reason: "BLOB_PUT_FAILED",
        });
        log.error("Upload could not store a file", appError.toLogObject());
        throw appError;
      }

      const asset: MediaAsset = {
        driveFileId: assetId,
        origin: "upload",
        storageKey,
        fileName: item.file.fileName.trim(),
        productCode,
        // Mode B carries no colour: the name means nothing here, and guessing
        // one would feed the colour filter a value the operator never chose.
        color: null,
        colorRaw: null,
        // 1-based position in the arranged album — see the note at the top.
        sequence: index + 1,
        kind: item.kind,
        variants: { aiGenerated: false, realPhoto: false, backView: false },
        mimeType: item.mimeType,
        sizeBytes,
        modifiedTime: null,
        warnings: [],
        // "Needs review" flags a file NAME that broke the convention; mode B has
        // no convention to break.
        needsReview: false,
      };

      try {
        await deps.media.registerUpload(tenantId, asset);
      } catch (error) {
        // The bytes are already on disk but nothing references them, and the
        // cleanup sweep works off rows — so it would never find them. Remove
        // them here instead of leaking a file nobody can name.
        const removed = await deps.blobs
          .delete({ tenantId, storageKey })
          .catch(() => false);

        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId,
          product_code: productCode,
          asset_id: assetId,
          file_name: asset.fileName,
          reason: "UPLOAD_REGISTER_FAILED",
          blob_rolled_back: removed,
        });
        log.error("Upload stored the bytes but could not register the asset", {
          ...appError.toLogObject(),
        });
        throw appError;
      }

      accepted.push(asset);
    }

    log.info("Upload accepted", {
      accepted: accepted.length,
      refused: rejected.length,
      media_kind: usable[0].kind,
      cover_file: accepted[0]?.fileName ?? null,
    });

    return { accepted, rejected };
  };
}

export type UploadMedia = ReturnType<typeof makeUploadMedia>;

// --- helpers ----------------------------------------------------------------

/**
 * One post is either an album of photos or a single clip — they are different
 * platform endpoints. Refusing here beats discovering it after the AI has
 * already been paid for a caption.
 */
function assertOneAlbumKind(
  usable: ReadonlyArray<{ kind: MediaKind; file: UploadedFile }>,
  context: { tenantId: string; productCode: string },
): void {
  const kinds = new Set(usable.map((item) => item.kind));

  if (kinds.size > 1) {
    throw new AppError("INVALID_INPUT", {
      message: "An uploaded album mixes photos and video",
      userMessage:
        "Một bài chỉ nhận ảnh hoặc video, không trộn lẫn. Hãy tách thành hai bài riêng.",
      context: {
        tenant_id: context.tenantId,
        product_code: context.productCode,
        reason: "MIXED_ALBUM_KIND",
      },
    });
  }

  if (usable[0].kind === "video" && usable.length > 1) {
    throw new AppError("INVALID_INPUT", {
      message: "A video post carries exactly one clip",
      userMessage: `Một bài video chỉ nhận một file — đang có ${usable.length}.`,
      context: {
        tenant_id: context.tenantId,
        product_code: context.productCode,
        reason: "MULTIPLE_VIDEOS",
        count: usable.length,
      },
    });
  }
}

/**
 * Puts the declared sizes through the same arrangement as the files, so index i
 * of both lists still describes the same file. Falls back to the byte length,
 * which is the honest number once the bytes are in hand.
 */
function arrangeSizes(
  input: UploadMediaInput,
  files: readonly UploadedFile[],
  arranged: readonly UploadedFile[],
): number[] {
  const declared = input?.declaredSizes;
  if (!Array.isArray(declared) || declared.length !== files.length) {
    return arranged.map((file) => file?.bytes?.length ?? 0);
  }

  const byFile = new Map<UploadedFile, number>();
  files.forEach((file, index) => byFile.set(file, declared[index]));
  return arranged.map((file) => byFile.get(file) ?? file?.bytes?.length ?? 0);
}
