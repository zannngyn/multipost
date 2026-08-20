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
  SyncIssueGroup,
  SyncRunCounts,
  SyncRunRepo,
  SyncRunStatus,
} from "@/core/ports/product-repo";
import type { SheetSource } from "@/core/ports/sheet-source";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";

/**
 * E2 — one catalog sync: read Drive + Sheet, reconcile, persist, and record why
 * every skipped file/row was skipped (CLAUDE.md business rule 5).
 *
 * Nothing here throws for bad DATA: a broken file name or a broken sheet row is
 * an issue on the run, not the end of the run. It only throws when the run
 * itself cannot be done (no tenant config, Drive/Sheet unreachable, DB down)
 * — plus ONE deliberate refusal: a source that answers "nothing" while the
 * database still holds rows stops the run instead of deleting them (see the
 * safety net before the persist block).
 */

/** A run must not write thousands of JSON rows; counts stay exact regardless. */
export const MAX_STORED_ISSUES = 200;

/** Examples kept per error code. Three is what the screen shows. */
export const MAX_ISSUE_EXAMPLES = 3;

/**
 * Issue codes written by this usecase. They are the operator's severity signal,
 * so three DIFFERENT situations must not share one code:
 *   FILE_NAME_INVALID  — file dropped, somebody has to rename it on Drive
 *   FILE_DUPLICATE     — same name twice, newest kept; nothing to fix
 *   FILE_NEEDS_REVIEW  — file WAS imported, but its name is ambiguous
 */
export const SYNC_ISSUE_CODES = {
  fileNameInvalid: "FILE_NAME_INVALID",
  fileDuplicate: "FILE_DUPLICATE",
  fileNeedsReview: "FILE_NEEDS_REVIEW",
  sheetError: "SHEET_ERROR",
  sheetRowInvalid: "SHEET_ROW_INVALID",
  productNotFound: "PRODUCT_NOT_FOUND",
  mediaNotFound: "MEDIA_NOT_FOUND",
  /** The run refused to delete a catalog the source stopped describing. */
  sourceEmpty: "SOURCE_EMPTY",
} as const;

/** One source that answered "nothing" while the database still holds rows. */
interface EmptySource {
  readonly source: "drive" | "sheet";
  /** Rows currently stored — the number that would have been deleted. */
  readonly existing: number;
}

/** Operator-facing sentence of the safety net. Vietnamese, with the numbers. */
function emptySourceDetail(item: EmptySource): string {
  return item.source === "drive"
    ? `Thư mục Drive không trả về file nào trong khi hệ thống đang lưu ${item.existing} ảnh. Đã dừng đồng bộ để không xoá nhầm — kiểm tra quyền truy cập thư mục, hoặc chọn lại nguồn.`
    : `Sheet không trả về dòng sản phẩm hợp lệ nào trong khi hệ thống đang lưu ${item.existing} sản phẩm. Đã dừng đồng bộ để không xoá nhầm — kiểm tra quyền truy cập bảng tính và tên tab, hoặc chọn lại nguồn.`;
}

export interface SyncCatalogInput {
  readonly tenantId: TenantId;
}

export interface SyncCatalogResult {
  readonly syncRunId: string;
  readonly status: SyncRunStatus;
  readonly counts: SyncRunCounts;
  /** Truncated to MAX_STORED_ISSUES — `counts` keeps the full picture. */
  readonly issues: readonly SyncIssue[];
  /** One row per error code with EXACT counts — never truncated. */
  readonly issueGroups: readonly SyncIssueGroup[];
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
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      deps.logger.warn("Catalog sync rejected: malformed tenant id", {
        error_code: "INVALID_INPUT",
        tenant_id: rawTenantId || null,
      });
      throw new AppError("INVALID_INPUT", {
        message: "tenantId must be a UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

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
    // Counted even when not stored: the operator must see that 250 files were
    // rejected, not just the 200 the run kept (business rule 5).
    let issuesTotal = 0;
    // Grouping happens BEFORE the cap, so "4.812 file sai tên" stays true even
    // though only 200 rows are stored. Bounded by the code vocabulary above.
    const groupByCode = new Map<string, { errorCode: string; count: number; examples: SyncIssue[] }>();
    const addIssue = (issue: SyncIssue) => {
      issuesTotal += 1;
      if (issues.length < MAX_STORED_ISSUES) issues.push(issue);

      const group = groupByCode.get(issue.errorCode);
      if (!group) {
        groupByCode.set(issue.errorCode, {
          errorCode: issue.errorCode,
          count: 1,
          examples: [issue],
        });
        return;
      }
      group.count += 1;
      if (group.examples.length < MAX_ISSUE_EXAMPLES) group.examples.push(issue);
    };
    const issueCounters = () => ({ issuesTotal, issuesTruncated: issuesTotal > issues.length });
    // Biggest group first: the fix on top removes the most rows. Ties break on
    // the code so two runs of the same data write the same order.
    const issueGroups = (): SyncIssueGroup[] =>
      [...groupByCode.values()].sort(
        (a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode),
      );

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
            errorCode: SYNC_ISSUE_CODES.sheetError,
            reason: "COLUMN_MISSING",
            ref: column,
            detail: `Tab '${config.sheetName}' không có cột '${column}' — thêm lại đúng tên cột rồi đồng bộ lại.`,
          });
        }
      }
      for (const column of snapshot.duplicateColumns) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.sheetError,
          reason: "COLUMN_DUPLICATED",
          ref: column,
          detail: `Cột '${column}' xuất hiện nhiều lần trên Sheet — hệ thống lấy cột đầu tiên. Xoá cột thừa để chắc chắn đọc đúng.`,
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
            errorCode: SYNC_ISSUE_CODES.sheetRowInvalid,
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
          errorCode: SYNC_ISSUE_CODES.sheetRowInvalid,
          reason: "DUPLICATE_CODE_CONFLICT",
          ref: product.content.code,
          detail: `Mã này nằm ở các dòng ${product.sourceRows.join(", ")} nhưng dữ liệu khác nhau — đã chặn đăng. Gộp về một dòng rồi đồng bộ lại.`,
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
          // The file is DROPPED — this is the only media issue an operator must
          // act on, so it keeps the error-shaped code.
          mediaRejected += 1;
          addIssue({
            errorCode: SYNC_ISSUE_CODES.fileNameInvalid,
            reason: asset.issue,
            ref: file.name,
            detail: asset.detail,
          });
          continue;
        }
        if (asset.note) {
          // The file WAS imported; the note is a "please look", not a rejection.
          addIssue({
            errorCode: SYNC_ISSUE_CODES.fileNeedsReview,
            reason: asset.note.reason,
            ref: file.name,
            detail: asset.note.detail,
          });
        }
        parsedAssets.push(asset.value);
      }

      const { kept, dropped } = dedupeMediaByName(parsedAssets);
      for (const duplicate of dropped) {
        // Nothing to fix on Drive: the run picked the newest copy on purpose.
        addIssue({
          errorCode: SYNC_ISSUE_CODES.fileDuplicate,
          reason: "DUPLICATE_FILE_NAME",
          ref: duplicate.fileName,
          detail: `Có nhiều file trùng tên; hệ thống giữ bản sửa gần nhất và bỏ bản cũ (file id ${duplicate.driveFileId}). Không cần sửa gì.`,
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
          errorCode: SYNC_ISSUE_CODES.productNotFound,
          reason: "MEDIA_WITHOUT_SHEET_ROW",
          ref: code,
          detail:
            "Drive có ảnh cho mã này nhưng Sheet chưa có dòng nào — thêm dòng vào Sheet (hoặc sửa mã trong tên file) rồi đồng bộ lại. Chưa đăng được.",
        });
      }
      for (const code of codesWithoutMedia) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.mediaNotFound,
          reason: "SHEET_ROW_WITHOUT_MEDIA",
          ref: code,
          detail:
            "Sheet có mã này nhưng thư mục Drive chưa có file nào khớp — tải ảnh lên (đặt tên MÃSP-Màu (số)) rồi đồng bộ lại. Chưa đăng được.",
        });
      }

      // --- Safety net: an empty source must not wipe a full catalog ---------
      //
      // Drive answers `files.list` with HTTP 200 and `files: []` when the
      // identity currently in use cannot SEE the folder — unlike `files.get`,
      // which answers 403/404. A sheet whose tab was renamed, emptied or is now
      // unreadable parses to zero valid rows just as quietly. Both would reach
      // `deleteStale` below, which removes every row this run did not stamp:
      // the whole catalog, silently, with the run reported as `succeeded`.
      //
      // This check belongs to the usecase, not to the Drive adapter: it must
      // also cover the Service Account tenants (a folder un-shared by mistake
      // looks exactly the same from here), and only the usecase knows both
      // numbers — what the source returned and what the database already holds.
      //
      // KNOWN TRADE-OFF, accepted by PM: a folder/sheet that was genuinely
      // emptied is blocked too, and an operator has to clear the catalog by
      // hand. An explicit "tôi biết, cứ xoá" override is a later ticket.
      const emptied: EmptySource[] = [];
      if (driveFiles.length === 0) {
        // Counts only `origin='drive'` rows — exactly the set deleteStale may
        // remove; uploaded assets (E9) belong to no sync run.
        const existing = await deps.media.countDriveAssets(tenantId);
        if (existing > 0) emptied.push({ source: "drive", existing });
      }
      if (productByCode.size === 0) {
        const existing = await deps.products.countAll(tenantId);
        if (existing > 0) emptied.push({ source: "sheet", existing });
      }
      if (emptied.length > 0) {
        for (const item of emptied) {
          addIssue({
            errorCode: SYNC_ISSUE_CODES.sourceEmpty,
            reason: item.source === "drive" ? "DRIVE_EMPTY" : "SHEET_EMPTY",
            ref: item.source === "drive" ? config.driveFolderId : config.spreadsheetId,
            detail: emptySourceDetail(item),
          });
        }
        runLog.error("Catalog sync stopped: the source came back empty while the catalog is not", {
          error_code: "SYNC_SOURCE_EMPTY",
          empty_sources: emptied.map((item) => item.source),
          drive_files_seen: driveFiles.length,
          existing_media: emptied.find((item) => item.source === "drive")?.existing ?? null,
          sheet_rows_seen: snapshot.rows.length,
          products_parsed: productByCode.size,
          existing_products: emptied.find((item) => item.source === "sheet")?.existing ?? null,
          drive_folder_id: config.driveFolderId,
          spreadsheet_id: config.spreadsheetId,
          sheet_name: config.sheetName,
        });
        throw new AppError("SYNC_SOURCE_EMPTY", {
          message: `Source returned nothing while the catalog is not empty: ${emptied
            .map((item) => `${item.source}=0 vs db=${item.existing}`)
            .join(", ")}`,
          userMessage: emptied.map(emptySourceDetail).join(" "),
          context: {
            tenant_id: tenantId,
            sync_run_id: syncRunId,
            empty_sources: emptied.map((item) => item.source),
            drive_files_seen: driveFiles.length,
            products_parsed: productByCode.size,
            existing: Object.fromEntries(emptied.map((item) => [item.source, item.existing])),
          },
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
        ...issueCounters(),
      };

      const status: SyncRunStatus =
        mediaRejected > 0 || sheetRowsRejected > 0 || schemaDrift.length > 0
          ? "partial"
          : "succeeded";

      const groups = issueGroups();
      await deps.syncRuns.finish({
        tenantId,
        syncRunId,
        status,
        finishedAt: deps.clock.now(),
        counts,
        issues,
        issueGroups: groups,
      });

      runLog.info("Catalog sync finished", {
        status,
        ...counts,
        issues_stored: issues.length,
        issue_groups: groups.map((group) => `${group.errorCode}=${group.count}`),
      });
      return { syncRunId, status, counts, issues, issueGroups: groups, schemaDrift };
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
          // The run produced no numbers, but the issues it did detect stay visible.
          counts: { ...emptyCounts(), ...issueCounters() },
          issues,
          issueGroups: issueGroups(),
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
            detail: `Tên file có nhiều mã sản phẩm; hệ thống gán file này cho ${name.productCode} (mã đứng đầu tên). Các mã còn lại: ${name.otherProductCodes.join(", ")}. Kiểm tra lại nếu ảnh thuộc mã khác.`,
          }
        : undefined,
    value: {
      driveFileId: file.id,
      origin: "drive",
      storageKey: null,
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
    issuesTotal: 0,
    issuesTruncated: false,
  };
}
