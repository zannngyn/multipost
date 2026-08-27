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

import { discardPreviousUploads } from "./discard-previous-uploads";
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
 *
 * A refused file lives ONLY under the staging prefix — it was never promoted.
 * Cleaning it up must call `deleteStaging`, never `delete` (serving-only): a
 * mismatched call is a silent no-op that leaks the object forever, because
 * the ticket row that could still name it gets deleted right after.
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
  /**
   * Batch-level notices that are not about any one file — currently just the
   * "your requested order was ignored" case. Vietnamese, safe to show as-is.
   */
  readonly warnings: readonly string[];
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

    // A repeated assetId would map two `arranged` entries to the SAME ticket:
    // under MinIO the first `promote` moves the staging object away, so the
    // second reads "object never arrived" after the first row is already
    // registered — a partially-registered batch masquerading as a clean one.
    const seenAssetIds = new Set<string>();
    for (const item of assets) {
      const assetId = item?.assetId;
      if (typeof assetId === "string" && seenAssetIds.has(assetId)) {
        throw new AppError("INVALID_INPUT", {
          message: "confirmUpload was called with a duplicate asset id",
          userMessage: "Yêu cầu xác nhận có file bị lặp — hãy tải lại trang và thử lại.",
          context: { tenant_id: tenantId, product_code: productCode, reason: "DUPLICATE_ASSET_ID", asset_id: assetId },
        });
      }
      if (typeof assetId === "string") seenAssetIds.add(assetId);
    }

    const log = deps.logger.child({ tenant_id: tenantId, product_code: productCode });
    const now = deps.clock.now();
    const warnings: string[] = [];

    const { arranged, orderIgnored } = applyOrder(assets, input?.order);
    if (orderIgnored) {
      // Business rule 5: nothing may silently diverge from what the operator
      // arranged. The fallback (keep the original order) is safe, but the
      // divergence itself must be visible, not just logged.
      log.warn("Confirm ignored a malformed upload order and kept the original arrangement", {
        error_code: "INVALID_INPUT",
        reason: "UPLOAD_ORDER_INVALID",
        asset_count: assets.length,
        order_length: Array.isArray(input?.order) ? input.order.length : null,
      });
      warnings.push(
        "Thứ tự sắp xếp gửi lên không hợp lệ — ảnh/video được giữ theo thứ tự đã tải lên, không theo thứ tự vừa kéo thả.",
      );
    }

    const ticketRows = await deps.tickets.findMany(tenantId, arranged.map((item) => item.assetId));
    const byAssetId = new Map(ticketRows.map((row) => [row.assetId, row]));

    // --- Per-file gate, in the mandated order --------------------------------
    const rejected: UploadRejectionReport[] = [];
    const usable: { assetId: string; fileName: string; mimeType: string; kind: MediaKind; sizeBytes: number }[] = [];
    const discard: string[] = [];

    for (const item of arranged) {
      // Ports document that `findMany` never returns another tenant's rows
      // (upload-ticket-repo.ts); a wrong-tenant ticket therefore reads
      // identically to no ticket at all here, and is refused the same way.
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
        // Unreachable while the sniffer only recognises whitelisted types
        // (media-sniff.ts), kept so a future signature added there without a
        // matching MediaKind mapping fails loudly instead of silently.
        log.warn("Confirm refused a file whose sniffed type maps to no supported media kind", {
          error_code: "INVALID_INPUT", reason: "UNSUPPORTED_TYPE",
          asset_id: item.assetId, file_name: ticket.fileName, sniffed_mime: actual,
        });
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

    await discardPreviousUploads(deps, { tenantId, productCode, log });

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
        // The bytes are already in the serving area (promote succeeded) but
        // no row points at them — the sweep works off rows, so it would
        // never find this. Delete right here instead. This IS `delete`, not
        // `deleteStaging`: by this point the object really is in serving.
        let removed = false;
        try {
          removed = await deps.blobs.delete({ tenantId, storageKey: promoted.storageKey });
        } catch (rollbackError) {
          // Never swallow this silently: an operator reading only
          // `blob_rolled_back: false` cannot tell "nothing to remove" from
          // "MinIO refused the delete", and an object stuck in serving with
          // no row is exactly the leak this rollback exists to prevent.
          log.error("Could not roll back a promoted object after its row failed to register", {
            ...AppError.from(rollbackError, "INTERNAL", {
              tenant_id: tenantId, product_code: productCode, asset_id: item.assetId,
              file_name: item.fileName, storage_key: promoted.storageKey, reason: "PROMOTE_ROLLBACK_FAILED",
            }).toLogObject(),
          });
        }
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

    return { accepted, rejected, warnings };
  };
}

export type ConfirmUpload = ReturnType<typeof makeConfirmUpload>;

// --- helpers -----------------------------------------------------------------

/**
 * `orderIgnored` is true whenever the supplied `order` could not be trusted
 * (wrong length, a repeated index, an out-of-range index) — the caller is
 * responsible for logging and surfacing that, `applyOrder` only decides the
 * safe fallback (keep the original arrangement).
 */
function applyOrder(
  assets: readonly { assetId: string }[],
  order: readonly number[] | undefined,
): { arranged: readonly { assetId: string }[]; orderIgnored: boolean } {
  if (order === undefined || order === null) {
    return { arranged: assets, orderIgnored: false };
  }
  if (!Array.isArray(order) || order.length !== assets.length) {
    return { arranged: assets, orderIgnored: true };
  }
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= assets.length || seen.has(index)) {
      return { arranged: assets, orderIgnored: true };
    }
    seen.add(index);
  }
  return { arranged: order.map((index) => assets[index]), orderIgnored: false };
}

/**
 * Clean up the object of every file just refused. Errors here are logged and
 * swallowed on purpose: the operator is waiting on a result, and the sweep
 * will pick up whatever is left over.
 *
 * MUST use `deleteStaging`: a refused file was never promoted, so its bytes
 * are only ever in the staging prefix. `delete` targets serving and would
 * silently no-op, and the ticket row deleted right after is the only other
 * thing that could ever have named the object again.
 *
 * Only the ticket rows whose staged object was ACTUALLY removed get deleted.
 * A row whose `deleteStaging` just failed is kept on purpose — mirrors
 * `cleanup-uploads.ts`'s "keep the row: it is the only handle left" rule.
 * The sweep iterates ticket rows to find orphaned staging objects; deleting a
 * row after a failed delete would strand that object with nothing left able
 * to name it again, forever.
 */
async function discardRefused(
  deps: ConfirmUploadDeps,
  tenantId: TenantId,
  assetIds: readonly string[],
  byAssetId: ReadonlyMap<string, { storageKey: string }>,
  log: Logger,
): Promise<void> {
  if (assetIds.length === 0) return;
  const clearedAssetIds: string[] = [];
  for (const assetId of assetIds) {
    const storageKey = byAssetId.get(assetId)?.storageKey;
    if (!storageKey) continue;
    try {
      await deps.blobs.deleteStaging({ tenantId, storageKey });
      clearedAssetIds.push(assetId);
    } catch (error) {
      // Keep the row: it is the only handle the sweep has left to retry this
      // object's staging delete next hour.
      log.warn("Could not remove a refused upload's staged bytes; keeping its ticket row for the sweep to retry", {
        ...AppError.from(error, "INTERNAL", { reason: "REFUSED_STAGING_DELETE_FAILED" }).toLogObject(),
        tenant_id: tenantId,
        asset_id: assetId,
      });
    }
  }
  if (clearedAssetIds.length === 0) return;
  try {
    await deps.tickets.deleteMany(tenantId, clearedAssetIds);
  } catch (error) {
    log.warn("Could not remove the tickets of refused uploads", {
      ...AppError.from(error, "DB_ERROR", { reason: "REFUSED_TICKET_DELETE_FAILED" }).toLogObject(),
      tenant_id: tenantId,
    });
  }
}

// `discardPreviousUploads` (replace, not merge, an earlier unposted attempt
// for this code) is shared with `upload-media.ts` — see
// `./discard-previous-uploads` for the full rationale. Unlike `discardRefused`
// above, its bytes live in the SERVING area (already promoted by an earlier
// confirm), so it correctly calls `blobs.delete`, never `deleteStaging`.
