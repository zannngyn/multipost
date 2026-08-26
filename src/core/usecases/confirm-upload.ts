import { AppError } from "@/core/domain/errors";
import type { MediaKind } from "@/core/domain/media-file-name";
import { sniffMediaMimeType } from "@/core/domain/media-sniff";
import { mediaKindFromMimeType } from "@/core/domain/media-file-name";
import type { MediaAsset } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import { MAX_UPLOAD_BYTES } from "@/core/domain/uploaded-media";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo } from "@/core/ports/product-repo";
import type { UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import { assertOneAlbumKind, type UploadRejectionReport } from "./upload-media";

/**
 * Stage 3 — the bytes already sit in MinIO's staging area; nobody has vetted
 * their kind yet.
 *
 * The order is MANDATORY, and it is the reason this usecase exists:
 *   ticket -> real size -> sniff first 4KB -> promote -> register.
 * Never reorder. Promoting before sniffing means an executable renamed .jpg
 * sits in the serving area, even for a few milliseconds.
 *
 * A bad file is REPORTED, not thrown (business rule 5). A batch where nothing
 * gets through DOES throw — there is no post left to carry on with.
 */

export interface ConfirmUploadInput {
  readonly tenantId: TenantId;
  readonly productCode: string;
  readonly assets: readonly { assetId: string }[];
  /** Indexes into `assets`; element 0 becomes the cover. Absent = keep as sent. */
  readonly order?: readonly number[];
}

export interface ConfirmUploadResult {
  readonly accepted: readonly MediaAsset[];
  readonly rejected: readonly UploadRejectionReport[];
}

export interface ConfirmUploadDeps {
  tickets: UploadTicketRepo;
  blobs: MediaBlobStore;
  media: MediaRepo;
  clock: Clock;
  logger: Logger;
}

export function makeConfirmUpload(deps: ConfirmUploadDeps) {
  return async function confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
    // --- Edge cases first ----------------------------------------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    const productCode =
      typeof input?.productCode === "string" ? input.productCode.trim().toUpperCase() : "";
    if (!isTenantId(rawTenantId) || productCode.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "confirmUpload requires a tenant UUID and a product code",
        userMessage: "Thiếu mã sản phẩm cho các file vừa tải lên.",
        context: { tenant_id: rawTenantId || null, product_code: productCode || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);
    const assets = Array.isArray(input?.assets) ? input.assets : [];
    if (assets.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "confirmUpload was called with no assets",
        userMessage: "Chưa có file nào để xác nhận.",
        context: { tenant_id: tenantId, product_code: productCode, reason: "EMPTY_ALBUM" },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });
    const arranged = applyOrder(assets, input?.order);
    const now = deps.clock.now();

    const ticketRows = await deps.tickets.findMany(tenantId, arranged.map((item) => item.assetId));
    const byAssetId = new Map(ticketRows.map((row) => [row.assetId, row]));

    // --- Per-file gate, in the mandated order --------------------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: { assetId: string; fileName: string; mimeType: string; kind: MediaKind; sizeBytes: number }[] = [];
    const discard: string[] = [];

    for (const item of arranged) {
      const ticket = byAssetId.get(item.assetId);

      if (!ticket) {
        log.warn("Confirm refused a file with no ticket", { error_code: "INVALID_INPUT", reason: "UPLOAD_TICKET_NOT_FOUND", asset_id: item.assetId });
        rejected.push({ fileName: "", reason: "UNSUPPORTED_TYPE", userMessage: "Phiên tải file đã kết thúc — hãy chọn lại file." });
        continue;
      }

      if (ticket.expiresAt.getTime() <= now.getTime()) {
        log.warn("Confirm refused an expired ticket", { error_code: "INVALID_INPUT", reason: "UPLOAD_TICKET_EXPIRED", asset_id: item.assetId, file_name: ticket.fileName });
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `Phiên tải "${ticket.fileName}" đã hết hạn — hãy chọn lại file.` });
        discard.push(item.assetId);
        continue;
      }

      // STAGING area: the object has not been promoted yet, `stat` would
      // always answer null here.
      const staged = await deps.blobs.statStaging({ tenantId, storageKey: ticket.storageKey });
      if (!staged) {
        log.warn("Confirm refused a file whose object never arrived", { error_code: "INVALID_INPUT", reason: "UPLOAD_OBJECT_MISSING", asset_id: item.assetId, file_name: ticket.fileName });
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `File "${ticket.fileName}" chưa lên tới nơi — hãy thử lại.` });
        discard.push(item.assetId);
        continue;
      }

      if (staged.sizeBytes <= 0 || staged.sizeBytes > MAX_UPLOAD_BYTES) {
        log.warn("Confirm refused a file whose real size is out of range", { error_code: "INVALID_INPUT", reason: "UPLOAD_SIZE_MISMATCH", asset_id: item.assetId, file_name: ticket.fileName, size_bytes: staged.sizeBytes });
        rejected.push({ fileName: ticket.fileName, reason: "TOO_LARGE", userMessage: `File "${ticket.fileName}" có kích thước không hợp lệ — file bị từ chối.` });
        discard.push(item.assetId);
        continue;
      }

      // The REAL gate: content decides, not the extension or the client's File.type.
      const head = await deps.blobs.readRange({ tenantId, storageKey: ticket.storageKey, length: 4096 });
      const actual = head ? sniffMediaMimeType(head) : null;
      if (!actual || actual !== ticket.declaredMime) {
        log.warn("Confirm refused a file whose content does not match its declared type", {
          error_code: "INVALID_INPUT", reason: "CONTENT_TYPE_MISMATCH",
          asset_id: item.assetId, file_name: ticket.fileName,
          declared_mime: ticket.declaredMime, sniffed_mime: actual,
        });
        rejected.push({
          fileName: ticket.fileName,
          reason: "UNSUPPORTED_TYPE",
          userMessage: `Nội dung file "${ticket.fileName}" không khớp định dạng khai báo — file bị từ chối.`,
        });
        discard.push(item.assetId);
        continue;
      }

      const kind = mediaKindFromMimeType(actual);
      if (!kind) {
        rejected.push({ fileName: ticket.fileName, reason: "UNSUPPORTED_TYPE", userMessage: `Định dạng file "${ticket.fileName}" không được hỗ trợ.` });
        discard.push(item.assetId);
        continue;
      }

      usable.push({ assetId: item.assetId, fileName: ticket.fileName, mimeType: actual, kind, sizeBytes: staged.sizeBytes });
    }

    await discardRefused(deps, tenantId, discard, byAssetId, log);

    if (usable.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "Every uploaded file was refused at confirm",
        userMessage: `Không nhận được file nào: ${rejected.map((item) => item.userMessage).join(" ")}`,
        context: { tenant_id: tenantId, product_code: productCode, refused: rejected.length },
      });
    }

    assertOneAlbumKind(usable.map((item) => item.kind), { tenantId, productCode });

    await discardPreviousUploads(deps, tenantId, productCode, log);

    // --- Promote, then register ----------------------------------------------
    const accepted: MediaAsset[] = [];

    for (const [index, item] of usable.entries()) {
      const promoted = await deps.blobs.promote({ tenantId, assetId: item.assetId });

      const asset: MediaAsset = {
        driveFileId: item.assetId,
        origin: "upload",
        storageKey: promoted.storageKey,
        fileName: item.fileName,
        productCode,
        // Mode B carries no color: nothing in the file name encodes it.
        color: null,
        colorRaw: null,
        sequence: index + 1,
        kind: item.kind,
        variants: { aiGenerated: false, realPhoto: false, backView: false },
        mimeType: item.mimeType,
        sizeBytes: promoted.sizeBytes,
        modifiedTime: null,
        warnings: [],
        needsReview: false,
      };

      try {
        await deps.media.registerUpload(tenantId, asset);
      } catch (error) {
        // The bytes are already in the serving area but no row points at
        // them — the sweep works off rows, so it would never find this.
        // Delete right here instead.
        const removed = await deps.blobs.delete({ tenantId, storageKey: promoted.storageKey }).catch(() => false);
        const appError = AppError.from(error, "DB_ERROR", {
          tenant_id: tenantId, product_code: productCode, asset_id: item.assetId,
          file_name: item.fileName, reason: "UPLOAD_REGISTER_FAILED", blob_rolled_back: removed,
        });
        log.error("Confirm promoted the bytes but could not register the asset", appError.toLogObject());
        throw appError;
      }

      accepted.push(asset);
    }

    await deps.tickets.deleteMany(tenantId, usable.map((item) => item.assetId));

    log.info("Confirm accepted", {
      accepted: accepted.length, refused: rejected.length,
      media_kind: usable[0].kind, cover_file: accepted[0]?.fileName ?? null,
    });

    return { accepted, rejected };
  };
}

export type ConfirmUpload = ReturnType<typeof makeConfirmUpload>;

// --- helpers -----------------------------------------------------------------

function applyOrder(
  assets: readonly { assetId: string }[],
  order: readonly number[] | undefined,
): readonly { assetId: string }[] {
  if (!Array.isArray(order) || order.length !== assets.length) return assets;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= assets.length || seen.has(index)) return assets;
    seen.add(index);
  }
  return order.map((index) => assets[index]);
}

/**
 * Clean up the object of every file just refused. Errors here are logged and
 * swallowed on purpose: the operator is waiting on a result, and the sweep
 * will pick up whatever is left over.
 */
async function discardRefused(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  assetIds: readonly string[],
  byAssetId: ReadonlyMap<string, { storageKey: string }>,
  log: Logger,
): Promise<void> {
  if (assetIds.length === 0) return;
  for (const assetId of assetIds) {
    const storageKey = byAssetId.get(assetId)?.storageKey;
    if (!storageKey) continue;
    try {
      await deps.blobs.delete({ tenantId, storageKey });
    } catch (error) {
      log.warn("Could not remove a refused upload's bytes", {
        ...AppError.from(error, "INTERNAL", { reason: "REFUSED_BLOB_DELETE_FAILED" }).toLogObject(),
        asset_id: assetId,
      });
    }
  }
  try {
    await deps.tickets.deleteMany(tenantId, assetIds);
  } catch (error) {
    log.warn("Could not remove the tickets of refused uploads", {
      ...AppError.from(error, "DB_ERROR", { reason: "REFUSED_TICKET_DELETE_FAILED" }).toLogObject(),
    });
  }
}

/**
 * Replace, not merge: `sequence` numbers from 1 every time, so a second
 * upload batch for the same code would collide with the first and compose
 * would return a scrambled album. Only uploads no post job references yet
 * are removed.
 */
async function discardPreviousUploads(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  productCode: string,
  log: Logger,
): Promise<void> {
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
    const removed = await deps.media.deleteUploads(tenantId, previous.map((item) => item.assetId));
    log.info("Replaced the previous upload attempt for this code", { removed });
  } catch (error) {
    log.error("Could not remove the rows of a replaced upload", {
      ...AppError.from(error, "DB_ERROR", { reason: "REPLACED_ROW_DELETE_FAILED" }).toLogObject(),
    });
  }
}
