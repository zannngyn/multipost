import {
  DEFAULT_STOCK_POLICY,
  suggestFieldMap,
  validateFieldMap,
  type CatalogFieldMap,
  type FieldMapIssue,
  type FieldSuggestion,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import { AppError } from "@/core/domain/errors";
import { parseDriveMediaRefs } from "@/core/domain/google-source-ref";
import { evaluateProductInventory } from "@/core/domain/inventory";
import { parseMediaFileName } from "@/core/domain/media-file-name";
import {
  DEFAULT_MEDIA_PROFILE,
  MEDIA_PROFILE_KINDS,
  MEDIA_PROFILE_LABELS,
  type MediaProfile as MediaProfileConfig,
  type MediaProfileKind,
} from "@/core/domain/media-profile";
import { resolveMedia, type MediaLinkCell, type MediaSourceFile } from "@/core/domain/media-resolver";
import { mergeDuplicateProducts, parseSheetRow, type Product } from "@/core/domain/product";
import { isTenantId } from "@/core/domain/tenant";
import { normalizeTenantId, type TenantId } from "@/core/domain/tenant-context";
import type { DriveFile, DriveListingLimit, DriveSource } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import {
  readCatalogText,
  resolveCatalogSourceRef,
  type CatalogTextReaderDeps,
} from "./read-catalog-text";

/**
 * "Compatibility report" — the productised version of docs/05, run BEFORE a
 * tenant finishes configuring anything.
 *
 * It answers the three questions an onboarding call actually asks: which
 * columns does this sheet have and what do they probably mean, how many rows
 * survive parsing, and — the number that decided the whole survey — how many
 * product codes could be posted TODAY (docs/05 section 4: exactly 20 of 299).
 *
 * Read-only: it writes nothing, changes no config and never syncs. A tenant may
 * run it against a spreadsheet they are still fixing.
 *
 * Failure policy, deliberately asymmetric:
 *   - the SHEET is the subject of the report; if it cannot be read there is no
 *     report, so the AppError propagates (logged with context first).
 *   - DRIVE is a bonus section; a Drive failure downgrades the report to
 *     `media: null` + a visible warning instead of losing the sheet analysis.
 */

/**
 * Hard cap on the Drive sample. The real folder holds 5,497 files (docs/05
 * section 1.1) and this runs while a human waits, so the report samples and
 * SAYS it sampled — `media.capped` + a warning sentence. Never silently partial.
 */
export const PROFILE_DRIVE_SAMPLE_LIMIT = 1000;

/**
 * Sub-folders the SAMPLE may walk. Lower than the sync's cap on purpose: this
 * runs while a human waits, folders are batched ~25 per Drive query, and the
 * report only has to recognise a layout — not import it. Hitting it is
 * reported like every other cap (`limitsHit` -> a warning).
 */
export const PROFILE_DRIVE_FOLDER_LIMIT = 200;

/** Examples kept per issue group. Three is what the screen shows. */
const MAX_EXAMPLES = 3;

/** Rows shown in "top vấn đề". */
const MAX_TOP_ISSUES = 5;

export interface ProfileCatalogSourceInput {
  readonly tenantId: TenantId;
  /**
   * WHICH SOURCE to profile (onboarding phase 3). Absent = the Google tab named
   * by the two fields below, which is what every caller did before phase 3.
   *
   * `{ kind: "file", storageKey, fileName }` profiles a CSV the tenant already
   * uploaded — without this, a customer with no Google Workspace could not run
   * step 2 of onboarding (the compatibility report) at all.
   */
  readonly textConfig?: CatalogTextConfig | null;
  /** Spreadsheet id. Required for a Google source, ignored for a file one. */
  readonly spreadsheetId?: string;
  /** Tab name, e.g. "Mẫu 2026". Required for a Google source. */
  readonly sheetName?: string;
  /** Optional: without it the report has no media/cross-check section. */
  readonly driveFolderId?: string | null;
  /**
   * Optional: preview a map the operator is editing. Absent = the SUGGESTED
   * map, which is what makes the report useful before anything is configured.
   */
  readonly fieldMap?: CatalogFieldMap | null;
  /** Optional: preview a stock policy. Absent = `numeric`. */
  readonly stockPolicy?: StockPolicy | null;
  /**
   * Optional: preview a media profile. Absent = `code-color-seq` (the internal
   * convention), so the numbers of a report nobody configured stay the ones
   * this usecase always produced. The four candidates are scored regardless —
   * that is what tells an operator which one to pick.
   */
  readonly mediaProfile?: MediaProfileConfig | null;
}

export interface IssueGroupSummary {
  /** Machine reason, English (MISSING_CODE, NO_PRODUCT_CODE...). */
  readonly reason: string;
  readonly count: number;
  /** Up to three real examples — a row number or a file name. */
  readonly examples: readonly string[];
  /** Sentence for the operator, Vietnamese. */
  readonly detail: string;
}

export interface SheetProfile {
  readonly columns: readonly string[];
  readonly duplicateColumns: readonly string[];
  readonly totalRows: number;
  /** Rows where every cell is empty — trailing noise, not an incident. */
  readonly emptyRows: number;
  readonly productsParsed: number;
  readonly rowsRejected: number;
  readonly rejectionGroups: readonly IssueGroupSummary[];
  /** Extra rows that collapsed into a code already seen (docs/05 section 2.5). */
  readonly duplicateCodes: number;
  /** Codes appearing on several rows with DIFFERENT data (blocked). */
  readonly conflictingCodes: readonly string[];
}

export interface FieldMapProfile {
  /** The map the numbers above were produced with. */
  readonly fieldMap: CatalogFieldMap;
  /** `tenant` = supplied by the caller, `suggested` = inferred here. */
  readonly source: "tenant" | "suggested";
  readonly fields: readonly FieldSuggestion[];
  readonly unmappedColumns: readonly string[];
  /** Unmapped columns that look like money — never read, shown as a hint. */
  readonly priceLikeColumns: readonly string[];
  readonly issues: readonly FieldMapIssue[];
}

export interface MediaProfile {
  /** Files actually looked at (<= PROFILE_DRIVE_SAMPLE_LIMIT). */
  readonly sampled: number;
  readonly cap: number;
  /** True when the folder holds more files than the sample. */
  readonly capped: boolean;
  readonly nameParsed: number;
  readonly nameRejected: number;
  /** 0..1, rounded to 3 decimals. Docs/05 measured 71.8% strict compliance. */
  readonly parseRate: number;
  /** Files matching the strict `MÃ-Màu (n).ext` convention. */
  readonly strictNames: number;
  /** Files with no extension at all (606 real files, docs/05 section 1.2). */
  readonly withoutExtension: number;
  /** File names seen more than once in the sample (docs/05 section 1.4). */
  readonly duplicateNames: number;
  readonly distinctCodes: number;
  readonly issueGroups: readonly IssueGroupSummary[];
}

/** One of the four media profiles, scored on the sample. */
export interface MediaProfileCandidate {
  readonly kind: MediaProfileKind;
  /** Operator-facing name of the kind (Vietnamese). */
  readonly label: string;
  /**
   * False when the sample cannot answer for this kind (no link column mapped,
   * or the Drive listing was flat so sub-folders were never seen). The
   * candidate is still returned — with `note` saying what is missing.
   */
  readonly applicable: boolean;
  readonly note: string | null;
  /** Assets the profile would produce out of the sampled files. */
  readonly assets: number;
  /** Files it would drop. */
  readonly rejected: number;
  /** Sheet codes that would get at least one photo — the thing that matters. */
  readonly codesMatched: number;
  /** `codesMatched / codes in the sheet`, 0..1 rounded to 3 decimals. */
  readonly score: number;
}

export interface MediaProfileSuggestion {
  /** Highest score; ties go to the earlier kind of MEDIA_PROFILE_KINDS. */
  readonly recommended: MediaProfileKind;
  /**
   * 0..1. The winner's score, halved when a runner-up is just as good — a tie
   * means "a human has to choose", and the UI must be able to say so.
   */
  readonly confidence: number;
  /** All four, best first. */
  readonly candidates: readonly MediaProfileCandidate[];
  /** Column the links were read from (mapped or detected). Null when none. */
  readonly mediaLinkColumn: string | null;
  /** True when the Drive sample included sub-folders. */
  readonly recursive: boolean;
}

export interface CrossCheckProfile {
  readonly codesInSheet: number;
  readonly codesInDrive: number;
  readonly codesInBoth: number;
  readonly codesOnlyInSheet: number;
  readonly codesOnlyInDrive: number;
  /** Matched codes the inventory table blocks. */
  readonly blockedByInventory: number;
  /** THE number: matched codes with photos and a stock decision that allows. */
  readonly postableNow: number;
  /** First 20 postable codes, for a "xem thử" list. */
  readonly postableSample: readonly string[];
  /**
   * True when `postableNow` was computed WITHOUT a stock check because the
   * tenant's policy is `disabled` — the number is optimistic by construction.
   */
  readonly stockCheckSkipped: boolean;
}

export interface CatalogProfileReport {
  readonly tenantId: TenantId;
  /** "" when the report was produced from an uploaded file. */
  readonly spreadsheetId: string;
  /** "" when the report was produced from an uploaded file. */
  readonly sheetName: string;
  /**
   * WHICH source these numbers describe. Null = the Google tab named above.
   * On the report itself so nobody can read a file report as a sheet one.
   */
  readonly textSource: CatalogTextConfig | null;
  readonly driveFolderId: string | null;
  readonly stockPolicyMode: StockPolicy["mode"];
  readonly sheet: SheetProfile;
  readonly fieldMap: FieldMapProfile;
  /** Null when no folder was given, or when Drive could not be read. */
  readonly media: MediaProfile | null;
  /** Null whenever `media` is null — the four kinds are scored on Drive files. */
  readonly mediaProfileSuggestion: MediaProfileSuggestion | null;
  /** Null whenever `media` is null — there is nothing to cross-check. */
  readonly crossCheck: CrossCheckProfile | null;
  /** Biggest problems first, already worded for an operator. */
  readonly topIssues: readonly IssueGroupSummary[];
  /** Caveats about the report itself (sampling, Drive unreadable...). */
  readonly warnings: readonly string[];
}

export interface ProfileCatalogSourceDeps extends CatalogTextReaderDeps {
  /**
   * Legacy wiring, still the default path for a Google tab (see
   * `readCatalogText`). Kept required so every existing caller compiles and a
   * sheet report never depends on new wiring.
   */
  sheet: SheetSource;
  /** Optional: a report can be produced from the table alone. */
  drive?: DriveSource;
  logger: Logger;
}

export function makeProfileCatalogSource(deps: ProfileCatalogSourceDeps) {
  return async function profileCatalogSource(
    input: ProfileCatalogSourceInput,
  ): Promise<CatalogProfileReport> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const rawTenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
    if (!isTenantId(rawTenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "profileCatalogSource requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: rawTenantId || null },
      });
    }
    const tenantId = normalizeTenantId(input.tenantId);

    const textConfig = input?.textConfig ?? null;
    const readsFile = textConfig?.kind === "file";

    const spreadsheetId = str(input?.spreadsheetId);
    // Only a Google source needs coordinates. A file source carries its own
    // identity in `textConfig`, and demanding a spreadsheet id from a tenant
    // who has none is exactly the wall phase 3 exists to remove.
    if (!readsFile && spreadsheetId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "profileCatalogSource requires a spreadsheetId",
        userMessage: "Thiếu mã bảng tính (spreadsheetId) cần kiểm tra.",
        context: { tenant_id: tenantId, field: "spreadsheetId" },
      });
    }

    const sheetName = str(input?.sheetName);
    if (!readsFile && sheetName.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "profileCatalogSource requires a sheetName",
        userMessage: "Nhập tên tab của bảng tính (ví dụ: Mẫu 2026).",
        context: { tenant_id: tenantId, field: "sheetName" },
      });
    }

    const driveFolderId = str(input?.driveFolderId) || null;
    const stockPolicy = input?.stockPolicy ?? DEFAULT_STOCK_POLICY;
    const log = deps.logger.child({ tenant_id: tenantId });
    const warnings: string[] = [];

    // --- The table: the subject of the report ------------------------------
    // Read through the SAME reader a sync uses, so the report can never
    // describe a different source than the one that will actually be synced.
    const sourceLabel = readsFile ? `file "${textConfig.fileName}"` : `tab '${sheetName}'`;
    let snapshot: SheetSnapshot;
    try {
      const ref = await resolveCatalogSourceRef(deps, {
        tenantId,
        textConfig,
        spreadsheetId,
        sheetName,
        log,
      });
      const read = await readCatalogText(deps, { tenantId, ref, log });
      snapshot = read.snapshot;
      // How the file was understood belongs in the report: a delimiter guessed
      // wrong is the difference between 300 products and one giant column.
      for (const notice of read.notices) warnings.push(notice.detail);
    } catch (error) {
      const appError = AppError.from(error, "SHEET_ERROR", {
        tenant_id: tenantId,
        spreadsheet_id: spreadsheetId || null,
        sheet_name: sheetName || null,
        text_source_kind: textConfig?.kind ?? "google_sheet",
      });
      log.error("Catalog profile failed: the product table could not be read", {
        error_code: appError.code,
        spreadsheet_id: spreadsheetId || null,
        sheet_name: sheetName || null,
        text_source_kind: textConfig?.kind ?? "google_sheet",
        err: appError,
        ...appError.toLogObject(),
      });
      throw appError;
    }

    const suggestion = suggestFieldMap(snapshot.columns);
    const fieldMap = input?.fieldMap ?? suggestion.fieldMap;
    const fieldMapSource = input?.fieldMap ? "tenant" : "suggested";
    const fieldMapIssues = validateFieldMap(fieldMap, snapshot.columns);

    if (snapshot.columns.length === 0) {
      warnings.push(
        `Bảng dữ liệu (${sourceLabel}) không có dòng tiêu đề nào đọc được — kiểm tra lại nguồn dữ liệu (tên tab, quyền truy cập, hoặc file đã tải lên).`,
      );
    }
    for (const column of snapshot.duplicateColumns) {
      warnings.push(
        `Cột '${column}' xuất hiện nhiều lần trong bảng dữ liệu — hệ thống chỉ đọc cột đầu tiên.`,
      );
    }

    const sheetProfile = profileRows(snapshot.rows, fieldMap);
    const products = sheetProfile.products;

    // --- Drive: a bonus section, never a reason to lose the report ----------
    let media: MediaProfileInternal | null = null;
    let sampledFiles: readonly DriveFile[] = [];
    let recursiveSample = false;
    if (driveFolderId && deps.drive) {
      try {
        // A recursive sample when the source can do one: without it the
        // `folder-per-code` candidate below can never be scored, and that is
        // exactly the tenant this report exists for. Capped like the flat one.
        let listingLimits: readonly DriveListingLimit[] = [];
        if (typeof deps.drive.listFilesDeep === "function") {
          const listing = await deps.drive.listFilesDeep({
            tenantId,
            folderId: driveFolderId,
            maxFiles: PROFILE_DRIVE_SAMPLE_LIMIT,
            maxFolders: PROFILE_DRIVE_FOLDER_LIMIT,
          });
          sampledFiles = listing.files;
          listingLimits = listing.limitsHit;
          recursiveSample = true;
        } else {
          sampledFiles = await deps.drive.listFiles({
            tenantId,
            folderId: driveFolderId,
            maxFiles: PROFILE_DRIVE_SAMPLE_LIMIT,
          });
        }
        if (listingLimits.length > 0) {
          warnings.push(
            `Thư mục Drive quá lớn nên chỉ quét được một phần (${listingLimits.join(", ")}) — các con số về ảnh là ước lượng trên phần đã quét.`,
          );
        }
        const files = sampledFiles;
        media = profileMedia(files);
        if (media.capped) {
          warnings.push(
            `Thư mục Drive có nhiều hơn ${PROFILE_DRIVE_SAMPLE_LIMIT} file — báo cáo chỉ lấy mẫu ${PROFILE_DRIVE_SAMPLE_LIMIT} file đầu, các con số về ảnh là ước lượng trên mẫu.`,
          );
        }
      } catch (error) {
        // Not swallowed: logged with its code and surfaced as a warning the
        // operator reads. The sheet half of the report stays valid.
        const appError = AppError.from(error, "DRIVE_ERROR", {
          tenant_id: tenantId,
          folder_id: driveFolderId,
        });
        log.warn("Catalog profile: Drive folder could not be read — media section omitted", {
          error_code: appError.code,
          drive_folder_id: driveFolderId,
          err: appError,
          ...appError.toLogObject(),
        });
        warnings.push(
          "Không đọc được thư mục Drive (kiểm tra quyền chia sẻ hoặc mã thư mục) — báo cáo chỉ có phần bảng tính.",
        );
      }
    } else if (driveFolderId && !deps.drive) {
      warnings.push("Chưa kết nối Drive nên báo cáo chỉ phân tích bảng tính.");
    }

    // --- Which media profile fits this tenant? -----------------------------
    const sheetCodes = [...products.keys()];
    const mediaLinkColumn = fieldMap.mediaLink ?? detectMediaLinkColumn(snapshot.rows);
    const mediaLinks = collectMediaLinks(snapshot.rows, fieldMap.code, mediaLinkColumn);
    const mediaProfileSuggestion = media
      ? scoreMediaProfiles({
          files: sampledFiles,
          sheetCodes,
          mediaLinks,
          mediaLinkColumn,
          recursive: recursiveSample,
          colors: input?.mediaProfile?.colors,
        })
      : null;
    if (mediaProfileSuggestion && mediaLinkColumn !== null && !fieldMap.mediaLink) {
      warnings.push(
        `Cột '${mediaLinkColumn}' trông như cột chứa link ảnh Drive — nếu đúng, khai nó vào phần nguồn ảnh để dùng link thay cho tên file.`,
      );
    }

    // The section below describes what the tenant's CURRENT (or previewed)
    // profile would do — absent = the internal convention, i.e. exactly the
    // numbers this report produced before phase 2.
    const effectiveProfile = input?.mediaProfile ?? DEFAULT_MEDIA_PROFILE;
    const effectiveCodes = media
      ? new Set(
          resolveMedia({
            files: sampledFiles,
            profile: effectiveProfile,
            knownCodes: sheetCodes,
            mediaLinks,
          }).assets.map((asset) => asset.productCode),
        )
      : null;
    const crossCheck = effectiveCodes ? crossCheckCodes(products, effectiveCodes, stockPolicy) : null;

    const topIssues = [...sheetProfile.rejectionGroups, ...(media?.issueGroups ?? [])]
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, MAX_TOP_ISSUES);

    log.info("Catalog profile produced", {
      spreadsheet_id: spreadsheetId,
      sheet_name: sheetName,
      text_source_kind: textConfig?.kind ?? "google_sheet",
      drive_folder_id: driveFolderId,
      field_map_source: fieldMapSource,
      stock_policy_mode: stockPolicy.mode,
      columns: snapshot.columns.length,
      sheet_rows: snapshot.rows.length,
      products_parsed: sheetProfile.productsParsed,
      rows_rejected: sheetProfile.rowsRejected,
      media_sampled: media?.sampled ?? 0,
      media_capped: media?.capped ?? false,
      media_recursive: recursiveSample,
      media_profile_effective: effectiveProfile.kind,
      media_profile_recommended: mediaProfileSuggestion?.recommended ?? null,
      media_profile_confidence: mediaProfileSuggestion?.confidence ?? null,
      postable_now: crossCheck?.postableNow ?? null,
    });

    return {
      tenantId,
      spreadsheetId,
      sheetName,
      textSource: textConfig,
      driveFolderId,
      stockPolicyMode: stockPolicy.mode,
      sheet: {
        columns: snapshot.columns,
        duplicateColumns: snapshot.duplicateColumns,
        totalRows: snapshot.rows.length,
        emptyRows: sheetProfile.emptyRows,
        productsParsed: sheetProfile.productsParsed,
        rowsRejected: sheetProfile.rowsRejected,
        rejectionGroups: sheetProfile.rejectionGroups,
        duplicateCodes: sheetProfile.duplicateCodes,
        conflictingCodes: sheetProfile.conflictingCodes,
      },
      fieldMap: {
        fieldMap,
        source: fieldMapSource,
        fields: suggestion.fields,
        unmappedColumns: suggestion.unmappedColumns,
        priceLikeColumns: suggestion.priceLikeColumns,
        issues: fieldMapIssues,
      },
      media: media ? stripCodes(media) : null,
      mediaProfileSuggestion,
      crossCheck,
      topIssues,
      warnings,
    };
  };
}

export type ProfileCatalogSource = ReturnType<typeof makeProfileCatalogSource>;

// --- Sheet half -------------------------------------------------------------

interface RowProfile extends Omit<SheetProfile, "columns" | "duplicateColumns" | "totalRows"> {
  readonly products: ReadonlyMap<string, Product>;
}

/** Vietnamese one-liner per rejection reason (the operator's to-do list). */
const ROW_ISSUE_DETAILS: Record<string, string> = {
  MISSING_CODE: "Dòng không có mã sản phẩm ở cột đã chọn.",
  MALFORMED_CODE: "Mã sản phẩm không dùng được (cần 4-20 ký tự chữ/số/dấu '-').",
  MISSING_NAME: "Dòng không có tên sản phẩm — caption mở đầu bằng tên nên không đăng được.",
  FIELD_MAP_INCOMPLETE: "Chưa chọn cột cho mã hoặc tên sản phẩm.",
};

function profileRows(
  rows: readonly { rowNumber: number; values: Readonly<Record<string, string>> }[],
  fieldMap: CatalogFieldMap,
): RowProfile {
  const products = new Map<string, Product>();
  const groups = new Map<string, { count: number; examples: string[] }>();
  let rowsRejected = 0;
  let emptyRows = 0;
  let duplicateCodes = 0;

  for (const row of rows) {
    const parsed = parseSheetRow(row.rowNumber, row.values, fieldMap);
    if (!parsed.ok) {
      const hasAnyValue = Object.values(row.values).some((value) => value.trim().length > 0);
      if (!hasAnyValue) {
        emptyRows += 1;
        continue;
      }
      rowsRejected += 1;
      addToGroup(groups, parsed.issue, `dòng ${parsed.rowNumber}`);
      continue;
    }

    const code = parsed.value.content.code;
    const existing = products.get(code);
    if (!existing) {
      products.set(code, parsed.value);
      continue;
    }
    duplicateCodes += 1;
    products.set(code, mergeDuplicateProducts(existing, parsed.value));
  }

  const conflictingCodes = [...products.values()]
    .filter((product) => product.hasConflict)
    .map((product) => product.content.code)
    .sort();

  return {
    products,
    emptyRows,
    productsParsed: products.size,
    rowsRejected,
    rejectionGroups: toSummaries(groups, ROW_ISSUE_DETAILS),
    duplicateCodes,
    conflictingCodes,
  };
}

// --- Drive half -------------------------------------------------------------

const MEDIA_ISSUE_DETAILS: Record<string, string> = {
  EMPTY_NAME: "File không có tên đọc được.",
  NO_PRODUCT_CODE:
    "Tên file không mở đầu bằng mã sản phẩm — đổi tên theo dạng MÃSP-Màu (số).jpg để dùng được.",
};

interface MediaProfileInternal extends MediaProfile {
  readonly codes: ReadonlySet<string>;
}

function profileMedia(files: readonly { name: string }[]): MediaProfileInternal {
  const groups = new Map<string, { count: number; examples: string[] }>();
  const codes = new Set<string>();
  const nameCounts = new Map<string, number>();
  let nameParsed = 0;
  let nameRejected = 0;
  let strictNames = 0;
  let withoutExtension = 0;

  for (const file of files) {
    const name = typeof file?.name === "string" ? file.name : "";
    const key = name.trim().toUpperCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);

    const parsed = parseMediaFileName(name);
    if (!parsed.ok) {
      nameRejected += 1;
      addToGroup(groups, parsed.issue, name || "(tên rỗng)");
      continue;
    }
    nameParsed += 1;
    codes.add(parsed.value.productCode);
    if (parsed.value.isStrict) strictNames += 1;
    if (parsed.value.extension === null) withoutExtension += 1;
  }

  const sampled = files.length;
  const duplicateNames = [...nameCounts.values()].filter((count) => count > 1).length;

  return {
    sampled,
    cap: PROFILE_DRIVE_SAMPLE_LIMIT,
    capped: sampled >= PROFILE_DRIVE_SAMPLE_LIMIT,
    nameParsed,
    nameRejected,
    parseRate: sampled === 0 ? 0 : Math.round((nameParsed / sampled) * 1000) / 1000,
    strictNames,
    withoutExtension,
    duplicateNames,
    distinctCodes: codes.size,
    issueGroups: toSummaries(groups, MEDIA_ISSUE_DETAILS),
    codes,
  };
}

function stripCodes(media: MediaProfileInternal): MediaProfile {
  const { codes: _codes, ...rest } = media;
  return rest;
}

// --- Which media profile fits? ----------------------------------------------

/** Rows scanned when looking for a column full of Drive links. */
const MAX_LINK_DETECTION_ROWS = 200;

/** A column qualifies when this share of its non-empty cells holds a link. */
const LINK_COLUMN_HIT_RATE = 0.5;

/**
 * Finds a column whose cells hold Drive links, so a tenant does not have to
 * know that "sheet-column" is even an option. Detection only — the column is
 * never USED until an operator maps it (the opt-in whitelist of phase 1).
 */
export function detectMediaLinkColumn(
  rows: readonly { values: Readonly<Record<string, string>> }[],
): string | null {
  const filled = new Map<string, number>();
  const hits = new Map<string, number>();

  for (const row of rows.slice(0, MAX_LINK_DETECTION_ROWS)) {
    for (const [column, value] of Object.entries(row?.values ?? {})) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      filled.set(column, (filled.get(column) ?? 0) + 1);
      if (parseDriveMediaRefs(value).length > 0) hits.set(column, (hits.get(column) ?? 0) + 1);
    }
  }

  let best: { column: string; rate: number; hits: number } | null = null;
  for (const [column, hitCount] of hits) {
    const rate = hitCount / (filled.get(column) ?? hitCount);
    if (rate < LINK_COLUMN_HIT_RATE) continue;
    // Deterministic: better rate, then more hits, then column name.
    if (
      !best ||
      rate > best.rate ||
      (rate === best.rate && hitCount > best.hits) ||
      (rate === best.rate && hitCount === best.hits && column < best.column)
    ) {
      best = { column, rate, hits: hitCount };
    }
  }
  return best?.column ?? null;
}

/** code -> the raw link cell, for every row that has both. */
function collectMediaLinks(
  rows: readonly { values: Readonly<Record<string, string>> }[],
  codeColumn: string | null,
  linkColumn: string | null,
): readonly MediaLinkCell[] {
  if (!codeColumn || !linkColumn) return [];
  const cells: MediaLinkCell[] = [];
  for (const row of rows) {
    const code = row?.values?.[codeColumn];
    const value = row?.values?.[linkColumn];
    if (typeof code !== "string" || code.trim().length === 0) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    cells.push({ code: code.trim(), value });
  }
  return cells;
}

/**
 * Who wins when two profiles match the SAME number of codes.
 *
 * The probing priority of `MEDIA_PROFILE_KINDS` with one deliberate swap:
 * `code-color-seq` is preferred over `code-in-name`. On identical coverage the
 * stricter convention is the better advice — it also reports the naming
 * deviations (missing colour, missing sequence) that the looser one accepts in
 * silence, and it is the behaviour the tenant already has.
 */
const TIE_BREAK_ORDER: readonly MediaProfileKind[] = [
  "sheet-column",
  "folder-per-code",
  "code-color-seq",
  "code-in-name",
];

interface ScoreMediaProfilesInput {
  readonly files: readonly MediaSourceFile[];
  readonly sheetCodes: readonly string[];
  readonly mediaLinks: readonly MediaLinkCell[];
  readonly mediaLinkColumn: string | null;
  readonly recursive: boolean;
  readonly colors?: MediaProfileConfig["colors"];
}

/**
 * Runs all four profiles over the SAME sample and scores them by the only
 * number that matters: how many product codes of the sheet end up with at
 * least one photo.
 *
 * This is what makes "cover mọi case" reachable — the tenant does not have to
 * know what shape their own Drive has, they pick the row with the best number.
 */
export function scoreMediaProfiles(input: ScoreMediaProfilesInput): MediaProfileSuggestion {
  const sheetCodes = new Set(input.sheetCodes.map((code) => code.trim().toUpperCase()));
  const candidates: MediaProfileCandidate[] = MEDIA_PROFILE_KINDS.map((kind) => {
    const note = inapplicableNote(kind, input);
    if (note !== null) {
      return {
        kind,
        label: MEDIA_PROFILE_LABELS[kind],
        applicable: false,
        note,
        assets: 0,
        rejected: 0,
        codesMatched: 0,
        score: 0,
      };
    }

    const result = resolveMedia({
      files: input.files,
      profile: { kind, ...(input.colors ? { colors: input.colors } : {}) } as MediaProfileConfig,
      knownCodes: [...sheetCodes],
      mediaLinks: input.mediaLinks,
    });
    const matched = new Set(
      result.assets.map((asset) => asset.productCode).filter((code) => sheetCodes.has(code)),
    );
    return {
      kind,
      label: MEDIA_PROFILE_LABELS[kind],
      applicable: true,
      note: null,
      assets: result.assets.length,
      rejected: result.rejected.length,
      codesMatched: matched.size,
      score: sheetCodes.size === 0 ? 0 : Math.round((matched.size / sheetCodes.size) * 1000) / 1000,
    };
  });

  const order = new Map(TIE_BREAK_ORDER.map((kind, index) => [kind, index]));
  const ranked = [...candidates].sort(
    (a, b) => b.score - a.score || (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0),
  );

  const winner = ranked[0];
  const runnerUp = ranked[1];
  // No profile matched anything: recommend the default rather than a guess, and
  // say confidence 0 — the report's issue list is the answer, not this row.
  if (!winner || winner.score === 0) {
    return {
      recommended: DEFAULT_MEDIA_PROFILE.kind,
      confidence: 0,
      candidates: ranked,
      mediaLinkColumn: input.mediaLinkColumn,
      recursive: input.recursive,
    };
  }

  const margin = runnerUp ? (winner.score - runnerUp.score) / winner.score : 1;
  const confidence = Math.round(winner.score * (0.5 + 0.5 * Math.max(0, Math.min(1, margin))) * 100) / 100;

  return {
    recommended: winner.kind,
    confidence,
    candidates: ranked,
    mediaLinkColumn: input.mediaLinkColumn,
    recursive: input.recursive,
  };
}

/** Null = the sample can answer for this kind. */
function inapplicableNote(kind: MediaProfileKind, input: ScoreMediaProfilesInput): string | null {
  if (kind === "sheet-column" && input.mediaLinks.length === 0) {
    return "Chưa tìm thấy cột nào chứa link Drive trên bảng tính — chọn cột link ảnh rồi chạy lại kiểm tra.";
  }
  if (kind === "folder-per-code" && !input.recursive) {
    return "Chưa quét được thư mục con nên chưa chấm điểm được cách này.";
  }
  if (
    kind === "folder-per-code" &&
    !input.files.some((file) => (file.folderPath?.length ?? 0) > 0)
  ) {
    return "Thư mục Drive không có thư mục con nào — cách này không áp dụng được.";
  }
  return null;
}

// --- Cross-check ------------------------------------------------------------

function crossCheckCodes(
  products: ReadonlyMap<string, Product>,
  driveCodes: ReadonlySet<string>,
  stockPolicy: StockPolicy,
): CrossCheckProfile {
  let codesInBoth = 0;
  let blockedByInventory = 0;
  const postable: string[] = [];

  for (const [code, product] of products) {
    if (!driveCodes.has(code)) continue;
    codesInBoth += 1;
    // Same decision table the composer and the publisher run — the report must
    // not be more optimistic than the thing that actually posts.
    const decision = evaluateProductInventory(product, stockPolicy);
    if (decision.blocked) {
      blockedByInventory += 1;
      continue;
    }
    postable.push(code);
  }

  const codesOnlyInDrive = [...driveCodes].filter((code) => !products.has(code)).length;

  return {
    codesInSheet: products.size,
    codesInDrive: driveCodes.size,
    codesInBoth,
    codesOnlyInSheet: products.size - codesInBoth,
    codesOnlyInDrive,
    blockedByInventory,
    postableNow: postable.length,
    postableSample: postable.sort().slice(0, 20),
    stockCheckSkipped: stockPolicy.mode === "disabled",
  };
}

// --- Shared helpers ---------------------------------------------------------

function addToGroup(
  groups: Map<string, { count: number; examples: string[] }>,
  reason: string,
  example: string,
): void {
  const group = groups.get(reason);
  if (!group) {
    groups.set(reason, { count: 1, examples: [example] });
    return;
  }
  group.count += 1;
  if (group.examples.length < MAX_EXAMPLES) group.examples.push(example);
}

function toSummaries(
  groups: ReadonlyMap<string, { count: number; examples: string[] }>,
  details: Record<string, string>,
): IssueGroupSummary[] {
  return [...groups.entries()]
    .map(([reason, group]) => ({
      reason,
      count: group.count,
      examples: group.examples,
      detail: details[reason] ?? `Lỗi ${reason}.`,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
