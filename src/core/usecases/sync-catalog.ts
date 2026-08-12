import { AppError } from "@/core/domain/errors";
import { mediaKindFromMimeType, parseMediaFileName } from "@/core/domain/media-file-name";
import {
  dedupeMediaByName,
  mergeDuplicateProducts,
  parseSheetRow,
  REQUIRED_SHEET_COLUMNS,
  SHEET_COLUMNS,
  type MediaAsset,
  type Product,
} from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import type { CatalogConfigRepo, DriveFile, DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  MediaRepo,
  ProductRepo,
  SyncIssue,
  SyncRunCounts,
  SyncRunRepo,
  SyncRunStatus,
} from "@/core/ports/product-repo";
import type { SheetSource } from "@/core/ports/sheet-source";

/**
 * E2 — one catalog sync: read Drive + Sheet, reconcile, persist, and record why
 * every skipped file/row was skipped (CLAUDE.md business rule 5).
 *
 * Nothing here throws for bad DATA: a broken file name or a broken sheet row is
 * an issue on the run, not the end of the run. It only throws when the run
 * itself cannot be done (no tenant config, Drive/Sheet unreachable, DB down).
 */

/** A run must not write thousands of JSON rows; counts stay exact regardless. */
const MAX_STORED_ISSUES = 200;

export interface SyncCatalogInput {
  readonly tenantId: string;
}

export interface SyncCatalogResult {
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  readonly counts: SyncRunCounts;
  /** Truncated to MAX_STORED_ISSUES — `counts` keeps the full picture. */
  readonly issues: readonly SyncIssue[];
  /** Expected columns that are missing/renamed in the sheet. */
  readonly schemaDrift: readonly string[];
}

export interface SyncCatalogDeps {
  drive: DriveSource;
  sheet: SheetSource;
  catalogConfig: CatalogConfigRepo;
  products: ProductRepo;
  media: MediaRepo;
  syncRuns: SyncRunRepo;
  clock: Clock;
  logger: Logger;
}

export function makeSyncCatalog(deps: SyncCatalogDeps) {
  return async function syncCatalog(input: SyncCatalogInput): Promise<SyncCatalogResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(tenantId)) {
      deps.logger.warn("Catalog sync rejected: malformed tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: tenantId || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "tenantId must be a UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: tenantId || null },
      });
    }

    const log = deps.logger.child({ tenant_id: tenantId });

    const config = await deps.catalogConfig.findCatalogConfig(tenantId);
    if (!config) {
      log.error("Catalog sync rejected: tenant has no Drive/Sheet integration", {
        error_code: "SYNC_FAILED",
      });
      throw new AppError("SYNC_FAILED", {
        message: "Tenant has no google catalog integration configured",
        userMessage:
          "Chưa cấu hình thư mục Drive / Sheet cho đơn vị này. Vào phần tích hợp để khai báo.",
        context: { tenant_id: tenantId },
      });
    }

    const startedAt = deps.clock.now();
    const { id: syncRunId } = await deps.syncRuns.start({ tenantId, source: config, startedAt });
    const runLog = log.child({ job_id: syncRunId });
    runLog.info("Catalog sync started", {
      drive_folder_id: config.driveFolderId,
      spreadsheet_id: config.spreadsheetId,
      sheet_name: config.sheetName,
    });

    const issues: SyncIssue[] = [];
    const addIssue = (issue: SyncIssue) => {
      if (issues.length < MAX_STORED_ISSUES) issues.push(issue);
    };

    try {
      // --- Sheet ----------------------------------------------------------
      const snapshot = await deps.sheet.readRows({
        tenantId,
        spreadsheetId: config.spreadsheetId,
        sheetName: config.sheetName,
      });

      const schemaDrift = Object.values(SHEET_COLUMNS).filter(
        (column) => !snapshot.columns.includes(column),
      );
      if (schemaDrift.length > 0) {
        // Never guess a renamed column by position — report and let a human look.
        runLog.warn("Sheet schema drift detected", {
          error_code: "SHEET_ERROR",
          missing_columns: schemaDrift,
        });
        for (const column of schemaDrift) {
          addIssue({
            errorCode: "SHEET_ERROR",
            reason: "COLUMN_MISSING",
            ref: column,
            detail: `Column '${column}' is missing from tab '${config.sheetName}'`,
          });
        }
      }
      for (const column of snapshot.duplicateColumns) {
        addIssue({
          errorCode: "SHEET_ERROR",
          reason: "COLUMN_DUPLICATED",
          ref: column,
          detail: `Column '${column}' appears more than once; the first one was used`,
        });
      }

      const missingRequired = REQUIRED_SHEET_COLUMNS.filter(
        (column) => !snapshot.columns.includes(column),
      );
      if (missingRequired.length > 0) {
        throw new AppError("SHEET_ERROR", {
          message: `Sheet is missing required columns: ${missingRequired.join(", ")}`,
          userMessage: `Sheet thiếu cột bắt buộc: ${missingRequired.join(", ")}. Không thể đồng bộ.`,
          context: { tenant_id: tenantId, sheet_name: config.sheetName, missingRequired },
        });
      }

      const productByCode = new Map<string, Product>();
      let sheetRowsRejected = 0;

      for (const row of snapshot.rows) {
        const parsedRow = parseSheetRow(row.rowNumber, row.values);
        if (!parsedRow.ok) {
          // A fully empty trailing row is noise, not an incident.
          const hasAnyValue = Object.values(row.values).some((value) => value.trim().length > 0);
          if (!hasAnyValue) continue;
          sheetRowsRejected += 1;
          addIssue({
            errorCode: "SHEET_ROW_INVALID",
            reason: parsedRow.issue,
            ref: `row ${parsedRow.rowNumber}`,
            detail: parsedRow.detail,
          });
          continue;
        }

        const code = parsedRow.value.content.code;
        const existing = productByCode.get(code);
        productByCode.set(code, existing ? mergeDuplicateProducts(existing, parsedRow.value) : parsedRow.value);
      }

      for (const product of productByCode.values()) {
        if (!product.hasConflict) continue;
        addIssue({
          errorCode: "SHEET_ROW_INVALID",
          reason: "DUPLICATE_CODE_CONFLICT",
          ref: product.content.code,
          detail: `Code appears on rows ${product.sourceRows.join(", ")} with conflicting data — posting is blocked`,
        });
      }

      // --- Drive ----------------------------------------------------------
      const driveFiles = await deps.drive.listFiles({
        tenantId,
        folderId: config.driveFolderId,
      });

      const parsedAssets: MediaAsset[] = [];
      let mediaRejected = 0;

      for (const file of driveFiles) {
        const asset = toMediaAsset(file);
        if (!asset.ok) {
          mediaRejected += 1;
          addIssue({
            errorCode: "FILE_NAME_INVALID",
            reason: asset.issue,
            ref: file.name,
            detail: asset.detail,
          });
          continue;
        }
        if (asset.note) {
          addIssue({
            errorCode: "FILE_NAME_INVALID",
            reason: asset.note.reason,
            ref: file.name,
            detail: asset.note.detail,
          });
        }
        parsedAssets.push(asset.value);
      }

      const { kept, dropped } = dedupeMediaByName(parsedAssets);
      for (const duplicate of dropped) {
        addIssue({
          errorCode: "FILE_NAME_INVALID",
          reason: "DUPLICATE_FILE_NAME",
          ref: duplicate.fileName,
          detail: `Older copy skipped (file id ${duplicate.driveFileId}); the newest modifiedTime wins`,
        });
      }

      // --- Cross-check Drive <-> Sheet -------------------------------------
      const codesWithMedia = new Set(kept.map((asset) => asset.productCode));
      const codesWithoutProduct = [...codesWithMedia].filter((code) => !productByCode.has(code));
      const codesWithoutMedia = [...productByCode.keys()].filter(
        (code) => !codesWithMedia.has(code),
      );

      for (const code of codesWithoutProduct) {
        addIssue({
          errorCode: "PRODUCT_NOT_FOUND",
          reason: "MEDIA_WITHOUT_SHEET_ROW",
          ref: code,
          detail: "Drive has photos for this code but the sheet has no row — cannot post it",
        });
      }
      for (const code of codesWithoutMedia) {
        addIssue({
          errorCode: "MEDIA_NOT_FOUND",
          reason: "SHEET_ROW_WITHOUT_MEDIA",
          ref: code,
          detail: "Sheet has a row for this code but the Drive folder has no matching file",
        });
      }

      // --- Persist ---------------------------------------------------------
      const products = [...productByCode.values()];
      const productsWritten = await deps.products.upsertMany(tenantId, products, syncRunId);
      const mediaWritten = await deps.media.upsertMany(tenantId, kept, syncRunId);
      const productsDeleted = await deps.products.deleteStale(tenantId, syncRunId);
      const mediaDeleted = await deps.media.deleteStale(tenantId, syncRunId);

      const counts: SyncRunCounts = {
        driveFilesSeen: driveFiles.length,
        mediaParsed: kept.length,
        mediaRejected,
        mediaDuplicatesDropped: dropped.length,
        mediaNeedingReview: kept.filter((asset) => asset.needsReview).length,
        sheetRowsSeen: snapshot.rows.length,
        productsParsed: products.length,
        sheetRowsRejected,
        productsWithConflict: products.filter((product) => product.hasConflict).length,
        productsWithoutMedia: codesWithoutMedia.length,
        mediaWithoutProduct: codesWithoutProduct.length,
        productsWritten,
        mediaWritten,
        productsDeleted,
        mediaDeleted,
      };

      const status: SyncRunStatus =
        mediaRejected > 0 || sheetRowsRejected > 0 || schemaDrift.length > 0
          ? "partial"
          : "succeeded";

      await deps.syncRuns.finish({
        tenantId,
        syncRunId,
        status,
        finishedAt: deps.clock.now(),
        counts,
        issues,
      });

      runLog.info("Catalog sync finished", { status, ...counts, issues_stored: issues.length });
      return { syncRunId, status, counts, issues, schemaDrift };
    } catch (error) {
      // Mark the run failed with a reason, then rethrow: never swallow, never
      // leave a `running` row behind (CLAUDE.md technical rules 4 + 5).
      const appError = AppError.from(error, "SYNC_FAILED", {
        tenant_id: tenantId,
        sync_run_id: syncRunId,
      });
      runLog.error("Catalog sync failed", {
        error_code: appError.code,
        err: appError,
        ...appError.toLogObject(),
      });

      try {
        await deps.syncRuns.finish({
          tenantId,
          syncRunId,
          status: "failed",
          finishedAt: deps.clock.now(),
          counts: emptyCounts(),
          issues,
          errorCode: appError.code,
          errorMessage: appError.message,
        });
      } catch (finishError) {
        // The DB is the thing that just broke — log and keep the original cause.
        runLog.error("Could not mark sync run as failed", {
          error_code: "DB_ERROR",
          err: finishError,
        });
      }

      throw appError;
    }
  };
}

export type SyncCatalog = ReturnType<typeof makeSyncCatalog>;

type MediaAssetResult =
  | {
      ok: true;
      value: MediaAsset;
      /** Kept file that still needs to appear on the review list. */
      note?: { reason: string; detail: string };
    }
  | { ok: false; issue: string; detail: string };

/** DriveFile + file-name parse -> MediaAsset, or a structured rejection. */
function toMediaAsset(file: DriveFile): MediaAssetResult {
  const parsed = parseMediaFileName(file.name);
  if (!parsed.ok) return { ok: false, issue: parsed.issue, detail: parsed.detail };

  const name = parsed.value;
  // The extension decides the kind; when there is none (606 real files) the
  // Drive mime type is the fallback, and the asset is flagged for confirmation.
  const kind = name.extension !== null ? name.kind : (mediaKindFromMimeType(file.mimeType) ?? name.kind);

  return {
    ok: true,
    // Outfit-set photos stay usable but must be visible on the review list.
    note:
      name.otherProductCodes.length > 0
        ? {
            reason: "MULTIPLE_PRODUCT_CODES",
            detail: `Attributed to ${name.productCode}; the name also carries ${name.otherProductCodes.join(", ")}`,
          }
        : undefined,
    value: {
      driveFileId: file.id,
      fileName: name.normalized,
      productCode: name.productCode,
      color: name.color,
      colorRaw: name.colorRaw,
      sequence: name.sequence,
      kind,
      variants: name.variants,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      modifiedTime: file.modifiedTime,
      warnings: name.warnings,
      needsReview: !name.isStrict,
    },
  };
}

function emptyCounts(): SyncRunCounts {
  return {
    driveFilesSeen: 0,
    mediaParsed: 0,
    mediaRejected: 0,
    mediaDuplicatesDropped: 0,
    mediaNeedingReview: 0,
    sheetRowsSeen: 0,
    productsParsed: 0,
    sheetRowsRejected: 0,
    productsWithConflict: 0,
    productsWithoutMedia: 0,
    mediaWithoutProduct: 0,
    productsWritten: 0,
    mediaWritten: 0,
    productsDeleted: 0,
    mediaDeleted: 0,
  };
}
