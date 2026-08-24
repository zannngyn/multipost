import {
  DEFAULT_CATALOG_TEXT_CONFIG,
  describeCatalogTextConfig,
  validateCatalogTextConfig,
  type CatalogTextConfig,
} from "@/core/domain/catalog-text-config";
import {
  DEFAULT_STOCK_POLICY,
  FIELD_LABELS,
  mappedColumns,
  MYSP_FIELD_MAP,
  validateFieldMapStructure,
  validateStockPolicy,
  type CatalogFieldMap,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import {
  DEFAULT_MEDIA_PROFILE,
  mediaProfileNeedsLinkColumn,
  mediaProfileNeedsRecursion,
  validateMediaProfile,
  type MediaProfile,
} from "@/core/domain/media-profile";
import { resolveMedia, type MediaLinkCell } from "@/core/domain/media-resolver";
import {
  dedupeMediaByName,
  mergeDuplicateProducts,
  parseSheetRow,
  type Product,
} from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import type {
  CatalogConfigRepo,
  DriveFile,
  DriveListingLimit,
  DriveSource,
} from "@/core/ports/drive-source";
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

import { readCatalogText, resolveCatalogSourceRef } from "./read-catalog-text";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type { CatalogTextSource } from "@/core/ports/catalog-text-source";
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
  /** The tenant's column mapping itself is questionable (warning-level). */
  fieldMapWarning: "FIELD_MAP_WARNING",
  /** The tenant's media profile is questionable (warning-level). */
  mediaProfileWarning: "MEDIA_PROFILE_WARNING",
  /** The recursive Drive listing hit a cap — the file list is incomplete. */
  driveTruncated: "DRIVE_LISTING_TRUNCATED",
  /** The profile needs a recursive listing this Drive source cannot produce. */
  driveUnsupported: "DRIVE_LISTING_UNSUPPORTED",
  productNotFound: "PRODUCT_NOT_FOUND",
  mediaNotFound: "MEDIA_NOT_FOUND",
  /** The run refused to delete a catalog the source stopped describing. */
  sourceEmpty: "SOURCE_EMPTY",
  /** How an uploaded file was understood (delimiter, ragged rows, blank rows). */
  catalogFileNotice: "CATALOG_FILE_NOTICE",
  /** No photo folder configured — the run synced product text only. */
  mediaSourceAbsent: "MEDIA_SOURCE_ABSENT",
} as const;

/** One source that answered "nothing" while the database still holds rows. */
interface EmptySource {
  readonly source: "drive" | "sheet";
  /** Rows currently stored — the number that would have been deleted. */
  readonly existing: number;
}

/** Operator-facing sentence of the safety net. Vietnamese, with the numbers. */
function emptySourceDetail(item: EmptySource, sourceLabel: string): string {
  return item.source === "drive"
    ? `Thư mục Drive không trả về file nào trong khi hệ thống đang lưu ${item.existing} ảnh. Đã dừng đồng bộ để không xoá nhầm — kiểm tra quyền truy cập thư mục, hoặc chọn lại nguồn.`
    : `Bảng dữ liệu (${sourceLabel}) không có dòng sản phẩm hợp lệ nào trong khi hệ thống đang lưu ${item.existing} sản phẩm. Đã dừng đồng bộ để không xoá nhầm — kiểm tra lại nguồn dữ liệu (quyền truy cập, tên tab, hoặc tải lại file), hoặc chọn lại nguồn.`;
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
  /**
   * Legacy single-source wiring, still the default path: used when
   * `catalogSources` has nothing that can read this tenant's source ref.
   *
   * It stays because a tenant on `google_sheet` must not depend on new wiring
   * to keep syncing. Once the container passes `catalogSources`, this is dead
   * weight and can go.
   */
  sheet: SheetSource;
  /**
   * Every product-text source this process can read from (phase 3). The run
   * picks by the tenant's `textSource` config — one list, one selection, and
   * the SAME parsing/persisting code below whichever one answers.
   *
   * Optional so a container wired before phase 3 keeps working; a tenant
   * configured for a file while this is empty fails with a named reason
   * instead of syncing an empty catalog.
   */
  catalogSources?: readonly CatalogTextSource[];
  /** Where an uploaded catalog file's bytes live. Required for a file tenant. */
  catalogFiles?: CatalogFileStore;
  /* Both of the above are `CatalogTextReaderDeps`, shared with the profiler. */
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

    // Absent map/policy = the internal preset, so a tenant configured before
    // onboarding existed syncs exactly as it did before (backward compatible).
    const fieldMap: CatalogFieldMap = config.fieldMap ?? MYSP_FIELD_MAP;
    const stockPolicy: StockPolicy = config.stockPolicy ?? DEFAULT_STOCK_POLICY;
    const mediaProfile: MediaProfile = config.mediaProfile ?? DEFAULT_MEDIA_PROFILE;
    // Absent = the Google tab, so a tenant configured before phase 3 reads
    // exactly what it always read.
    const textConfig: CatalogTextConfig = config.textSource ?? DEFAULT_CATALOG_TEXT_CONFIG;
    const sourceLabel = describeCatalogTextConfig(textConfig, config.sheetName);
    // A tenant may legitimately have no photo folder (uploaded photos only).
    const driveFolderId =
      typeof config.driveFolderId === "string" ? config.driveFolderId.trim() : "";
    const mediaSyncEnabled = driveFolderId.length > 0;

    const startedAt = deps.clock.now();
    const { id: syncRunId } = await deps.syncRuns.start({ tenantId, source: config, startedAt });
    const runLog = log.child({ job_id: syncRunId });
    runLog.info("Catalog sync started", {
      text_source_kind: textConfig.kind,
      text_source: sourceLabel,
      media_sync_enabled: mediaSyncEnabled,
      drive_folder_id: config.driveFolderId,
      spreadsheet_id: config.spreadsheetId,
      sheet_name: config.sheetName,
      field_map_preset: config.fieldMap ? "tenant" : "mysp_default",
      stock_policy_mode: stockPolicy.mode,
      media_profile_kind: mediaProfile.kind,
      media_profile_preset: config.mediaProfile ? "tenant" : "mysp_default",
    });

    if (stockPolicy.mode === "disabled") {
      // Loud on purpose: this tenant posts without the stock gate of business
      // rule 3, and the audit trail has to say so on every run.
      runLog.warn("Stock check is DISABLED for this tenant — posts will not be gated by stock", {
        error_code: "STOCK_CHECK_DISABLED",
        stock_policy_mode: "disabled",
        stock_policy_reason: stockPolicy.reason,
      });
    }

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
      // --- The tenant's mapping, before anything is read --------------------
      //
      // A map that cannot describe a product (no code/name column, one column
      // used twice) would turn every row into "dòng trống" and the run into a
      // silent catalog wipe, so it stops the run here with a named reason.
      const mapIssues = validateFieldMapStructure(fieldMap);
      const blockingMapIssues = mapIssues.filter((issue) => issue.severity === "error");
      if (blockingMapIssues.length > 0) {
        runLog.error("Catalog sync rejected: the tenant field map is unusable", {
          error_code: "SHEET_ERROR",
          field_map_issues: blockingMapIssues.map((issue) => issue.code),
        });
        throw new AppError("SHEET_ERROR", {
          message: `Field map is unusable: ${blockingMapIssues.map((issue) => issue.code).join(", ")}`,
          userMessage: blockingMapIssues.map((issue) => issue.detail).join(" "),
          context: {
            tenant_id: tenantId,
            sheet_name: config.sheetName,
            issues: blockingMapIssues.map((issue) => issue.code),
          },
        });
      }
      for (const issue of mapIssues) {
        // Warnings (a caption field pointed at a price-looking column) are
        // shown, never silent, and never a reason to stop the run.
        addIssue({
          errorCode: SYNC_ISSUE_CODES.fieldMapWarning,
          reason: issue.code,
          ref: issue.column ?? issue.fields.join(","),
          detail: issue.detail,
        });
      }

      // --- The tenant's media profile ---------------------------------------
      //
      // Same rule as the field map: an unusable profile would attribute every
      // photo to nothing, so it stops the run with a named reason. Colour
      // problems are warnings — they cost a filter, never a photo.
      const mediaProfileIssues = validateMediaProfile(mediaProfile);
      const blockingMediaIssues = mediaProfileIssues.filter(
        (issue) => issue.severity === "error",
      );
      if (blockingMediaIssues.length > 0) {
        runLog.error("Catalog sync rejected: the tenant media profile is unusable", {
          error_code: "SYNC_FAILED",
          media_profile_issues: blockingMediaIssues.map((issue) => issue.code),
        });
        throw new AppError("SYNC_FAILED", {
          message: `Media profile is unusable: ${blockingMediaIssues.map((issue) => issue.code).join(", ")}`,
          userMessage: blockingMediaIssues.map((issue) => issue.detail).join(" "),
          context: {
            tenant_id: tenantId,
            media_profile_kind: (mediaProfile as { kind?: unknown }).kind ?? null,
            issues: blockingMediaIssues.map((issue) => issue.code),
          },
        });
      }
      for (const issue of mediaProfileIssues) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.mediaProfileWarning,
          reason: issue.code,
          ref: mediaProfile.kind,
          detail: issue.detail,
        });
      }

      // `sheet-column` reads a column of the tenant's own sheet; without it
      // there is nothing to resolve, and guessing a column would attach random
      // photos to products.
      if (mediaProfileNeedsLinkColumn(mediaProfile) && !fieldMap.mediaLink) {
        runLog.error("Catalog sync rejected: media profile needs a link column that is not mapped", {
          error_code: "SHEET_ERROR",
          media_profile_kind: mediaProfile.kind,
        });
        throw new AppError("SHEET_ERROR", {
          message: "mediaProfile 'sheet-column' requires fieldMap.mediaLink",
          userMessage:
            "Đang chọn cách 'link ảnh nằm trên bảng tính' nhưng chưa khai cột chứa link ảnh — vào cấu hình nguồn dữ liệu để chọn cột đó.",
          context: { tenant_id: tenantId, media_profile_kind: mediaProfile.kind },
        });
      }

      // --- The tenant's text source ----------------------------------------
      //
      // Same rule as the field map: a source that cannot be read would turn the
      // run into an empty catalog, so it stops here with a named reason rather
      // than a run reporting "0 product rows".
      const textConfigIssues = validateCatalogTextConfig(textConfig);
      if (textConfigIssues.length > 0) {
        runLog.error("Catalog sync rejected: the tenant text source is unusable", {
          error_code: "SYNC_FAILED",
          text_source_kind: (textConfig as { kind?: unknown }).kind ?? null,
          text_source_issues: textConfigIssues.map((issue) => issue.code),
        });
        throw new AppError("SYNC_FAILED", {
          message: `Catalog text source is unusable: ${textConfigIssues
            .map((issue) => issue.code)
            .join(", ")}`,
          userMessage: textConfigIssues.map((issue) => issue.detail).join(" "),
          context: {
            tenant_id: tenantId,
            reason: "TEXT_SOURCE_INVALID",
            issues: textConfigIssues.map((issue) => issue.code),
          },
        });
      }

      const stockPolicyIssues = validateStockPolicy(stockPolicy);
      if (stockPolicyIssues.length > 0) {
        runLog.error("Catalog sync rejected: the tenant stock policy is unusable", {
          error_code: "SHEET_ERROR",
          stock_policy_issues: stockPolicyIssues.map((issue) => issue.code),
        });
        throw new AppError("SHEET_ERROR", {
          message: `Stock policy is unusable: ${stockPolicyIssues.map((issue) => issue.code).join(", ")}`,
          userMessage: stockPolicyIssues.map((issue) => issue.detail).join(" "),
          context: {
            tenant_id: tenantId,
            stock_policy_mode: stockPolicy.mode,
            issues: stockPolicyIssues.map((issue) => issue.code),
          },
        });
      }

      // --- Product text: ONE read, whichever source the tenant configured ---
      //
      // Everything below this line is source-agnostic on purpose: a Google tab
      // and an uploaded CSV both arrive as the same `CatalogSnapshot`, so the
      // field map, the row parser and the persist block have no idea which one
      // they are looking at — and cannot drift apart per source.
      const ref = await resolveCatalogSourceRef(deps, {
        tenantId,
        textConfig,
        spreadsheetId: config.spreadsheetId,
        sheetName: config.sheetName,
        log: runLog,
      });
      const read = await readCatalogText(deps, { tenantId, ref, log: runLog });
      const snapshot = read.snapshot;

      // How the source was understood is never silent: a file read with the
      // wrong separator, with ragged rows or with blank rows dropped shows up
      // as issues on the run (business rule 5).
      for (const notice of read.notices) {
        // `DUPLICATE_COLUMN` is reported by this usecase a few lines below, for
        // every source. Passing the source's own copy through too would show the
        // operator the same problem twice.
        if (notice.code === "DUPLICATE_COLUMN") continue;
        addIssue({
          errorCode: SYNC_ISSUE_CODES.catalogFileNotice,
          reason: notice.code,
          ref: notice.examples[0] ?? sourceLabel,
          detail: notice.detail,
        });
      }

      // Drift is measured against the columns THIS tenant mapped, not against
      // our own headers — a customer sheet has none of ours.
      const schemaDrift = mappedColumns(fieldMap).filter(
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
            detail: `Bảng dữ liệu (${sourceLabel}) không có cột '${column}' — thêm lại đúng tên cột rồi đồng bộ lại.`,
          });
        }
      }
      for (const column of snapshot.duplicateColumns) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.sheetError,
          reason: "COLUMN_DUPLICATED",
          ref: column,
          detail: `Cột '${column}' xuất hiện nhiều lần trong bảng dữ liệu — hệ thống lấy cột đầu tiên. Xoá cột thừa để chắc chắn đọc đúng.`,
        });
      }

      const missingRequired = ([["code", fieldMap.code], ["name", fieldMap.name]] as const)
        .filter(([, column]) => column !== null && !snapshot.columns.includes(column))
        .map(([field, column]) => `${column} (${FIELD_LABELS[field]})`);
      if (missingRequired.length > 0) {
        throw new AppError("SHEET_ERROR", {
          message: `Sheet is missing required columns: ${missingRequired.join(", ")}`,
          userMessage: `Bảng dữ liệu (${sourceLabel}) thiếu cột bắt buộc: ${missingRequired.join(", ")}. Không thể đồng bộ.`,
          context: { tenant_id: tenantId, sheet_name: config.sheetName, missingRequired },
        });
      }

      const productByCode = new Map<string, Product>();
      // Only read for the `sheet-column` profile: an unmapped column stays
      // invisible to the parser (the opt-in whitelist of phase 1).
      const linkColumn = mediaProfileNeedsLinkColumn(mediaProfile)
        ? (fieldMap.mediaLink ?? null)
        : null;
      const mediaLinks: MediaLinkCell[] = [];
      let sheetRowsRejected = 0;

      for (const row of snapshot.rows) {
        const parsedRow = parseSheetRow(row.rowNumber, row.values, fieldMap);
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

        if (linkColumn !== null) {
          const cell = row.values[linkColumn];
          if (typeof cell === "string" && cell.trim().length > 0) {
            mediaLinks.push({ code, value: cell });
          }
        }
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
      //
      // Flat by DEFAULT (one query per page). Only the profiles that put the
      // product code outside the file name pay for a recursive walk, and that
      // walk reports every cap it hits so a truncated listing cannot be
      // mistaken for "these files are gone".
      const needsRecursion = mediaProfileNeedsRecursion(mediaProfile);
      let driveFiles: readonly DriveFile[] = [];
      let listingLimits: readonly DriveListingLimit[] = [];

      if (!mediaSyncEnabled) {
        // A tenant on uploaded photos (mode B) has no folder to list. Saying so
        // once is the whole point: without it every product would be reported
        // as "chua co anh" and the media half would try to delete rows it never
        // looked at.
        runLog.info("Catalog sync: no photo folder configured, syncing product text only", {
          text_source_kind: textConfig.kind,
        });
        addIssue({
          errorCode: SYNC_ISSUE_CODES.mediaSourceAbsent,
          reason: "NO_DRIVE_FOLDER",
          ref: sourceLabel,
          detail:
            "Đơn vị chưa khai thư mục ảnh trên Drive nên lần đồng bộ này chỉ cập nhật dữ liệu sản phẩm. Ảnh của bài đăng lấy từ chế độ tự tải lên.",
        });
      } else if (needsRecursion && typeof deps.drive.listFilesDeep === "function") {
        const listing = await deps.drive.listFilesDeep({
          tenantId,
          folderId: driveFolderId,
        });
        driveFiles = listing.files;
        listingLimits = listing.limitsHit;
        runLog.info("Drive listed recursively", {
          media_profile_kind: mediaProfile.kind,
          drive_files_seen: driveFiles.length,
          folders_visited: listing.foldersVisited,
          depth_reached: listing.depthReached,
          limits_hit: listing.limitsHit,
        });
      } else {
        if (needsRecursion) {
          // Never silent: this profile CANNOT work on a flat listing, and the
          // operator has to know why their folders produced nothing.
          runLog.error("Media profile needs a recursive listing this Drive source cannot do", {
            error_code: "DRIVE_ERROR",
            media_profile_kind: mediaProfile.kind,
          });
          addIssue({
            errorCode: SYNC_ISSUE_CODES.driveUnsupported,
            reason: "RECURSIVE_LISTING_UNSUPPORTED",
            ref: config.driveFolderId,
            detail:
              "Cách nhận ảnh đang chọn cần quét cả thư mục con nhưng kết nối Drive hiện tại không hỗ trợ — báo kỹ thuật, hoặc đổi sang cách 'mã nằm trong tên file'.",
          });
        }
        driveFiles = await deps.drive.listFiles({
          tenantId,
          folderId: driveFolderId,
        });
      }

      if (listingLimits.length > 0) {
        // The listing is PARTIAL. Files still get imported, but the media
        // `deleteStale` in the persist block below is skipped.
        addIssue({
          errorCode: SYNC_ISSUE_CODES.driveTruncated,
          reason: listingLimits.join(","),
          ref: config.driveFolderId,
          detail: `Thư mục Drive quá lớn nên hệ thống mới quét được ${driveFiles.length} file (giới hạn: ${listingLimits.join(", ")}). Ảnh đã quét vẫn dùng được, nhưng chưa dọn ảnh cũ. Chia bớt thư mục rồi đồng bộ lại.`,
        });
      }

      const resolution = resolveMedia({
        files: driveFiles,
        profile: mediaProfile,
        // The tenant's OWN codes, so a code of any shape is recognised inside a
        // free-form file or folder name.
        knownCodes: [...productByCode.keys()],
        mediaLinks,
      });

      // The file is DROPPED — this is the only media issue an operator must act
      // on, so it keeps the error-shaped code.
      for (const issue of resolution.rejected) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.fileNameInvalid,
          reason: issue.reason,
          ref: issue.ref,
          detail: issue.detail,
        });
      }
      // The file WAS imported; a review is a "please look", not a rejection.
      for (const issue of resolution.reviews) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.fileNeedsReview,
          reason: issue.reason,
          ref: issue.ref,
          detail: issue.detail,
        });
      }

      const parsedAssets = resolution.assets;
      const mediaRejected = resolution.rejected.length;

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

      // Skipped when there is no photo folder: "Sheet có mã này nhưng Drive chưa
      // có file" is not true of a tenant that has no Drive folder at all, and
      // one issue per product would bury the real ones.
      for (const code of mediaSyncEnabled ? codesWithoutProduct : []) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.productNotFound,
          reason: "MEDIA_WITHOUT_SHEET_ROW",
          ref: code,
          detail:
            "Drive có ảnh cho mã này nhưng bảng dữ liệu chưa có dòng nào — thêm dòng vào bảng dữ liệu (hoặc sửa mã trong tên file) rồi đồng bộ lại. Chưa đăng được.",
        });
      }
      for (const code of mediaSyncEnabled ? codesWithoutMedia : []) {
        addIssue({
          errorCode: SYNC_ISSUE_CODES.mediaNotFound,
          reason: "SHEET_ROW_WITHOUT_MEDIA",
          ref: code,
          detail:
            "Bảng dữ liệu có mã này nhưng thư mục Drive chưa có file nào khớp — tải ảnh lên (đặt tên MÃSP-Màu (số)) rồi đồng bộ lại. Chưa đăng được.",
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
      if (mediaSyncEnabled && driveFiles.length === 0) {
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
            ref: item.source === "drive" ? driveFolderId : sourceLabel,
            detail: emptySourceDetail(item, sourceLabel),
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
          userMessage: emptied.map((item) => emptySourceDetail(item, sourceLabel)).join(" "),
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
      const mediaWritten = mediaSyncEnabled
        ? await deps.media.upsertMany(tenantId, kept, syncRunId)
        : 0;
      const productsDeleted = await deps.products.deleteStale(tenantId, syncRunId);
      // Two reasons to keep media rows this run did not stamp:
      //   - a TRUNCATED listing did not see every file, so deleting would remove
      //     photos that are still on Drive;
      //   - no photo folder is configured at all, so this run knows nothing
      //     about the tenant's media and has no business deleting any of it.
      // Same reasoning as the empty-source guard above: when in doubt, keep the
      // rows and say so.
      const mediaDeleted =
        listingLimits.length > 0 || !mediaSyncEnabled
          ? 0
          : await deps.media.deleteStale(tenantId, syncRunId);

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
