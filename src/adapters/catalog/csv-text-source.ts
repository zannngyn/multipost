import { z } from "zod";

import { buildCatalogSnapshot } from "@/core/domain/catalog-snapshot";
import { AppError } from "@/core/domain/errors";
import { normalizeTenantId } from "@/core/domain/tenant-context";
import type {
  CatalogFileRef,
  CatalogReadNotice,
  CatalogSourceRef,
  CatalogTextResult,
  CatalogTextSource,
  ReadCatalogTextInput,
} from "@/core/ports/catalog-text-source";
import type { Logger } from "@/core/ports/infra";
import {
  decodeCsvText,
  isCsvDelimiter,
  looksBinary,
  looksLikeZipArchive,
  parseCsv,
  type CsvIssue,
} from "@/shared/csv";

/**
 * CatalogTextSource over a file the tenant uploaded (onboarding phase 3) — the
 * bottom rung: a customer with no Google Workspace exports their price list to
 * CSV and the whole pipeline works, because this answers with the SAME
 * `CatalogSnapshot` a Google tab does.
 *
 * Everything here treats the bytes as hostile (technical rule 2): size cap
 * first, binary sniff second, encoding third, and only then the parser. Nothing
 * about the file is assumed silently — the delimiter that was detected, the
 * encoding, the rows that did not match the header and the blank lines dropped
 * at the end all come back in `format`/`notices` for the operator to see.
 *
 * PENDING(error-code): CATALOG_FILE_* codes do not exist in errors.ts yet
 * (adding one means adding a status in app/api/_lib/http-errors.ts, another
 * agent's file). INVALID_INPUT is the honest fallback — the FILE is the invalid
 * input — and `reason` carries the precise meaning for logs and the UI.
 */

/** Bigger than any real price list; refused rather than buffered and parsed. */
export const MAX_CATALOG_FILE_BYTES = 5 * 1024 * 1024;

/** Extensions this adapter claims. `txt`/`tsv` are what Excel writes too. */
const TEXT_EXTENSIONS = new Set(["csv", "tsv", "txt", "tab"]);

/** Extensions that are a spreadsheet BINARY — another adapter's job. */
const WORKBOOK_EXTENSIONS = new Set(["xlsx", "xlsm", "xls", "ods", "numbers"]);

const TEXT_CONTENT_TYPES = new Set([
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/csv",
  "application/x-csv",
  "text/comma-separated-values",
  // Browsers send this when they cannot tell; the bytes decide.
  "application/octet-stream",
]);

/**
 * ZERO replacement characters are tolerated. A U+FFFD means a byte was not
 * valid UTF-8, which for a Vietnamese price list means "Tồn" reads as "T?n" —
 * importing that as a product name is worse than refusing the file, and the fix
 * (re-export as CSV UTF-8) takes the operator ten seconds.
 */
const MAX_REPLACEMENT_CHARS = 0;

/** Content types that mean "spreadsheet binary" whatever the name says. */
const WORKBOOK_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Row numbers / column names quoted in a notice. */
const MAX_NOTICE_EXAMPLES = 3;

const FileRefSchema = z.object({
  kind: z.literal("file"),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(255).nullable().optional(),
  bytes: z.instanceof(Uint8Array),
  delimiter: z.string().max(4).optional(),
  sheetName: z.string().max(255).nullable().optional(),
});

export interface CsvCatalogTextSourceDeps {
  logger: Logger;
  /** Override for tests; defaults to MAX_CATALOG_FILE_BYTES. */
  maxBytes?: number;
}

export const CSV_TEXT_SOURCE_ID = "csv-file";

export function makeCsvCatalogTextSource(deps: CsvCatalogTextSourceDeps): CatalogTextSource {
  const maxBytes =
    typeof deps?.maxBytes === "number" && deps.maxBytes > 0 ? deps.maxBytes : MAX_CATALOG_FILE_BYTES;

  return {
    id: CSV_TEXT_SOURCE_ID,

    /**
     * Every uploaded file is this adapter's business — CSV is the only upload
     * format there is (PM decision). Answering "not mine" to an .xlsx would
     * leave nobody to explain the fix, so a workbook is accepted here and
     * refused in `readCatalog` with the export instructions. Never throws.
     */
    canRead(ref: CatalogSourceRef): boolean {
      return ref?.kind === "file";
    },

    async readCatalog(input: ReadCatalogTextInput): Promise<CatalogTextResult> {
      // --- Edge cases first (CLAUDE.md technical rule 1) -------------------
      const tenantId = normalizeTenantId(input?.tenantId);
      const parsedRef = FileRefSchema.safeParse(input?.ref);
      if (!parsedRef.success) {
        throw new AppError("INVALID_INPUT", {
          message: "csv catalog source received a ref that is not a readable file",
          userMessage: "File dữ liệu tải lên không hợp lệ — hãy chọn lại file .csv.",
          context: {
            tenant_id: tenantId,
            reason: "CATALOG_FILE_REF_INVALID",
            issues: parsedRef.error.issues.map((issue) => issue.path.join(".") || "(root)"),
          },
        });
      }

      const ref: CatalogFileRef = {
        kind: "file",
        fileName: parsedRef.data.fileName,
        contentType: parsedRef.data.contentType ?? null,
        bytes: parsedRef.data.bytes,
        ...(parsedRef.data.delimiter === undefined ? {} : { delimiter: parsedRef.data.delimiter }),
      };
      const log = deps.logger.child({ tenant_id: tenantId, file_name: ref.fileName });
      const fail = (reason: string, userMessage: string, extra: Record<string, unknown> = {}) => {
        const error = new AppError("INVALID_INPUT", {
          message: `Uploaded catalog file rejected: ${reason}`,
          userMessage,
          context: {
            tenant_id: tenantId,
            file_name: ref.fileName,
            size_bytes: ref.bytes.length,
            reason,
            ...extra,
          },
        });
        log.warn("Uploaded catalog file rejected", { ...error.toLogObject(), reason });
        return error;
      };

      // Name/type first: they are the cheapest signal and they carry the most
      // useful message ("this is Excel, here is how to export CSV").
      const extension = fileExtension(ref.fileName);
      const contentType = normaliseContentType(ref.contentType);
      if (WORKBOOK_EXTENSIONS.has(extension) || WORKBOOK_CONTENT_TYPES.has(contentType)) {
        throw fail(
          "CATALOG_FILE_IS_WORKBOOK",
          `File "${ref.fileName}" là bảng tính Excel, hệ thống chỉ đọc được CSV. Mở file trong Excel, chọn “File → Save As / Lưu dưới dạng” rồi chọn định dạng “CSV UTF-8 (Comma delimited)”, sau đó tải file .csv vừa lưu lên.`,
          { extension: extension || null, content_type: contentType || null },
        );
      }
      if (
        extension.length > 0 &&
        !TEXT_EXTENSIONS.has(extension) &&
        !TEXT_CONTENT_TYPES.has(contentType)
      ) {
        throw fail(
          "CATALOG_FILE_EXTENSION_UNSUPPORTED",
          `Đuôi file “.${extension}” không phải file CSV. Hãy xuất bảng sản phẩm ra định dạng “CSV UTF-8” rồi tải lên lại.`,
          { extension, content_type: contentType || null },
        );
      }

      if (ref.bytes.length === 0) {
        throw fail("CATALOG_FILE_EMPTY", "File tải lên rỗng (0 byte) — hãy xuất lại file rồi thử lại.");
      }
      if (ref.bytes.length > maxBytes) {
        throw fail(
          "CATALOG_FILE_TOO_LARGE",
          `File tải lên nặng ${formatMb(ref.bytes.length)} MB, vượt giới hạn ${formatMb(maxBytes)} MB — hãy xoá bớt cột/dòng không cần rồi xuất lại.`,
          { max_bytes: maxBytes },
        );
      }
      // Then the bytes: an .xlsx renamed to .csv passes every check above.
      if (looksBinary(ref.bytes)) {
        throw fail(
          looksLikeZipArchive(ref.bytes) ? "CATALOG_FILE_IS_WORKBOOK" : "CATALOG_FILE_NOT_TEXT",
          looksLikeZipArchive(ref.bytes)
            ? `File “${ref.fileName}” mang tên .csv nhưng bên trong vẫn là file Excel. Mở trong Excel, chọn “File → Save As / Lưu dưới dạng” và chọn “CSV UTF-8 (Comma delimited)” — đổi tên đuôi file là không đủ.`
            : `File “${ref.fileName}” không phải văn bản CSV. Hãy xuất lại bảng sản phẩm từ Excel hoặc Google Sheets dưới dạng “CSV UTF-8” rồi tải lên.`,
        );
      }

      const decoded = decodeCsvText(ref.bytes);
      if (decoded.replacementCount > MAX_REPLACEMENT_CHARS) {
        throw fail(
          "CATALOG_FILE_ENCODING",
          `File này không dùng bảng mã UTF-8 nên chữ tiếng Việt bị lỗi (${decoded.replacementCount} ký tự không đọc được). Trong Excel: “File → Save As / Lưu dưới dạng” → chọn “CSV UTF-8 (Comma delimited)”. Trong Google Sheets: “Tệp → Tải xuống → Giá trị được phân tách bằng dấu phẩy (.csv)”.`,
          { encoding: decoded.encoding, replacement_chars: decoded.replacementCount },
        );
      }

      const forced = isCsvDelimiter(ref.delimiter) ? ref.delimiter : undefined;
      const parsed = parseCsv(decoded.text, forced ? { delimiter: forced } : {});
      if (parsed.rows.length === 0) {
        throw fail(
          "CATALOG_FILE_NO_ROWS",
          "File không có dòng dữ liệu nào đọc được — kiểm tra lại file rồi tải lên lại.",
          { encoding: decoded.encoding },
        );
      }

      const snapshot = buildCatalogSnapshot(parsed.rows, { firstRowNumber: parsed.firstRowNumber });
      const notices = buildNotices({
        issues: parsed.issues,
        duplicateColumns: snapshot.duplicateColumns,
        columnCount: snapshot.columns.length,
        trailingEmptyRows: parsed.trailingEmptyRows,
        leadingEmptyRows: parsed.leadingEmptyRows,
        separatorDirective: parsed.separatorDirective,
        delimiter: parsed.delimiter,
        delimiterDetected: parsed.delimiterDetected,
      });

      log.info("Uploaded catalog file read", {
        size_bytes: ref.bytes.length,
        encoding: decoded.encoding,
        had_bom: decoded.hadBom,
        delimiter: describeDelimiter(parsed.delimiter),
        delimiter_detected: parsed.delimiterDetected,
        first_row_number: parsed.firstRowNumber,
        columns: snapshot.columns.length,
        rows: snapshot.rows.length,
        duplicate_columns: snapshot.duplicateColumns,
        notice_codes: notices.map((notice) => notice.code),
      });

      return {
        snapshot,
        format: {
          source: CSV_TEXT_SOURCE_ID,
          delimiter: parsed.delimiter,
          encoding: decoded.encoding,
          detected: parsed.delimiterDetected,
        },
        notices,
      };
    },
  };
}

// --- helpers ----------------------------------------------------------------

function fileExtension(fileName: string): string {
  const name = typeof fileName === "string" ? fileName.trim() : "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function normaliseContentType(contentType: string | null | undefined): string {
  if (typeof contentType !== "string") return "";
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Operator-facing name of a separator — "\t" on screen helps nobody. */
export function describeDelimiter(delimiter: string): string {
  if (delimiter === "\t") return "Tab";
  if (delimiter === ";") return "Dấu chấm phẩy (;)";
  if (delimiter === ",") return "Dấu phẩy (,)";
  if (delimiter === "|") return "Dấu gạch đứng (|)";
  return delimiter;
}

interface NoticeInput {
  issues: readonly CsvIssue[];
  duplicateColumns: readonly string[];
  columnCount: number;
  trailingEmptyRows: number;
  leadingEmptyRows: number;
  separatorDirective: string | null;
  delimiter: string;
  delimiterDetected: boolean;
}

/**
 * Turns every deviation into ONE operator sentence per kind, with a count and
 * a few row numbers. Grouped rather than one-per-row on purpose: a file with
 * 300 ragged rows must not produce 300 messages nobody reads.
 */
function buildNotices(input: NoticeInput): CatalogReadNotice[] {
  const notices: CatalogReadNotice[] = [];

  if (input.separatorDirective !== null) {
    notices.push({
      code: "SEPARATOR_DIRECTIVE",
      count: 1,
      examples: [describeDelimiter(input.separatorDirective)],
      detail: `Dòng đầu file có khai báo "sep=${input.separatorDirective}" (Excel tự thêm) — hệ thống đã đọc theo khai báo đó và bỏ qua dòng này.`,
    });
  }

  if (input.delimiterDetected) {
    notices.push({
      code: "DELIMITER_DETECTED",
      count: 1,
      examples: [describeDelimiter(input.delimiter)],
      detail: `Hệ thống đang hiểu file này ngăn cách các cột bằng ${describeDelimiter(input.delimiter)}. Nếu các cột hiển thị sai, chọn lại ký tự ngăn cách rồi tải lên lại.`,
    });
  }

  if (input.columnCount === 0) {
    notices.push({
      code: "NO_HEADER_ROW",
      count: 1,
      examples: [],
      detail:
        "Dòng đầu tiên của file không có tiêu đề cột nào đọc được — hệ thống đọc cột theo TÊN nên chưa dùng được file này.",
    });
  }

  if (input.duplicateColumns.length > 0) {
    notices.push({
      code: "DUPLICATE_COLUMN",
      count: input.duplicateColumns.length,
      examples: input.duplicateColumns.slice(0, MAX_NOTICE_EXAMPLES),
      detail: `File có cột bị trùng tên (${input.duplicateColumns.slice(0, MAX_NOTICE_EXAMPLES).join(", ")}) — hệ thống chỉ đọc cột xuất hiện đầu tiên.`,
    });
  }

  const unterminated = input.issues.filter((issue) => issue.code === "UNTERMINATED_QUOTE");
  if (unterminated.length > 0) {
    notices.push({
      code: "UNTERMINATED_QUOTE",
      count: unterminated.length,
      examples: unterminated.slice(0, MAX_NOTICE_EXAMPLES).map((issue) => `dòng ${issue.recordNumber}`),
      detail: `Có dấu ngoặc kép mở mà không đóng (từ dòng ${unterminated[0]?.recordNumber}) — phần còn lại của file bị gộp vào một ô. Sửa dấu ngoặc kép rồi tải lên lại.`,
    });
  }

  const ragged = input.issues.filter((issue) => issue.code === "RAGGED_ROW");
  if (ragged.length > 0) {
    notices.push({
      code: "RAGGED_ROW",
      count: ragged.length,
      examples: ragged.slice(0, MAX_NOTICE_EXAMPLES).map((issue) => `dòng ${issue.recordNumber}`),
      detail: `${ragged.length} dòng có số cột khác dòng tiêu đề (ví dụ: dòng ${ragged
        .slice(0, MAX_NOTICE_EXAMPLES)
        .map((issue) => issue.recordNumber)
        .join(", ")}) — các ô thiếu được coi là ô trống.`,
    });
  }

  const stray = input.issues.filter((issue) => issue.code === "STRAY_QUOTE");
  if (stray.length > 0) {
    notices.push({
      code: "STRAY_QUOTE",
      count: stray.length,
      examples: stray.slice(0, MAX_NOTICE_EXAMPLES).map((issue) => `dòng ${issue.recordNumber}`),
      detail: `${stray.length} dòng có dấu ngoặc kép nằm giữa ô — hệ thống giữ nguyên ký tự đó trong nội dung.`,
    });
  }

  if (input.trailingEmptyRows > 0) {
    notices.push({
      code: "TRAILING_EMPTY_ROWS",
      count: input.trailingEmptyRows,
      examples: [],
      detail: `Đã bỏ qua ${input.trailingEmptyRows} dòng trống ở cuối file.`,
    });
  }

  if (input.leadingEmptyRows > 0) {
    notices.push({
      code: "LEADING_EMPTY_ROWS",
      count: input.leadingEmptyRows,
      examples: [],
      detail: `Đã bỏ qua ${input.leadingEmptyRows} dòng trống ở đầu file — dòng tiêu đề được lấy là dòng ngay sau đó.`,
    });
  }

  return notices;
}
