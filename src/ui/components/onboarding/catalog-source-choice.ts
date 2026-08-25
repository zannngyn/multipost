import { formatDateTime } from "@/ui/components/sync/sync-format";
import type { CatalogTextSource, CatalogTextSourceKind } from "@/ui/schemas/catalog-mapping.schema";
import { formatFileBytes, type CatalogSource } from "@/ui/schemas/catalog.schema";

/**
 * Step 1 of "Kết nối dữ liệu": WHERE this tenant's product table comes from.
 *
 * Two ways in, and they are EQUALS. Google Drive/Sheet is listed first because
 * it is the one that also brings photos, not because the other is a fallback:
 * onboarding phase 3 exists for the customer whose data is too dirty to sync or
 * who has no Google Workspace at all, and a screen that files their only usable
 * option under "nâng cao" tells them they are a second-class customer.
 *
 * Pure module — the screen renders what this returns, and every branch is
 * testable in the node environment the repo already runs (same reasoning as
 * `data-mapping-steps.ts`).
 */

export interface CatalogSourceChoice {
  readonly kind: CatalogTextSourceKind;
  readonly label: string;
  /** One line: what this option IS, in the customer's terms. */
  readonly summary: string;
  /** Who it is for. Neither of these may read as "the lesser option". */
  readonly fitFor: string;
}

export const CATALOG_SOURCE_CHOICES: readonly CatalogSourceChoice[] = [
  {
    kind: "google_sheet",
    label: "Bảng Google Sheet",
    summary: "Hệ thống đọc thẳng bảng tính của bạn, mỗi lần đồng bộ lấy số mới nhất.",
    fitFor: "Hợp khi đơn vị đang dùng Google Workspace và ảnh cũng để trên Google Drive.",
  },
  {
    kind: "file",
    label: "Tải file CSV lên",
    summary: "Bạn xuất bảng sản phẩm ra file CSV rồi tải lên. Không cần tài khoản Google.",
    fitFor:
      "Hợp khi đơn vị dùng Excel trên máy, dùng phần mềm bán hàng khác, hoặc chưa muốn chia sẻ bảng tính.",
  },
] as const;

/**
 * WHY ONLY CSV, said where the operator is about to pick a file.
 *
 * PM decision (24/08/2026): reading `.xlsx` would mean a new dependency and
 * nobody approved one. The rule is stated BEFORE the picker rather than after a
 * failed upload — somebody who exports the wrong format, waits for the upload
 * and only then reads "hệ thống chỉ đọc CSV" has been told too late, and it is
 * the kind of thing that makes a customer decide the tool does not work.
 */
export const CATALOG_FILE_RULE = "Hệ thống chỉ đọc file CSV — không đọc được .xlsx của Excel.";

/**
 * The export, in the words of the two menus a Vietnamese shop owner actually
 * has in front of them. UTF-8 is called out on its own line because it is the
 * one that silently ruins the data: a Windows-1258 export uploads fine, reads
 * fine, and turns "Váy hoa nhí" into "Vßy hoa nhÝ" in every caption.
 */
export const CATALOG_FILE_EXPORT_STEPS: readonly string[] = [
  "Excel: File → Save As / Lưu dưới dạng → chọn định dạng “CSV UTF-8 (Comma delimited)”.",
  "Google Sheets: Tệp → Tải xuống → “Giá trị được phân tách bằng dấu phẩy (.csv)”.",
  "Nhớ chọn đúng bản UTF-8 — tên sản phẩm tiếng Việt có dấu sẽ hỏng nếu lưu bảng mã khác.",
  "Dòng đầu tiên phải là tên cột (Mã sản phẩm, Tên sản phẩm, Tồn…) — hệ thống đọc cột theo TÊN.",
];

/**
 * Which option this tenant is on right now.
 *
 * Absent config reads as `google_sheet`, the same contract the domain keeps:
 * every tenant onboarded before phase 3 has no `textSource` key at all, and
 * inferring anything else would tell them their tab is gone.
 */
export function activeSourceChoice(
  source: CatalogSource | null | undefined,
): CatalogTextSourceKind {
  return source?.textSource?.kind === "file" ? "file" : "google_sheet";
}

/**
 * Is step 1 finished for the source this tenant is on?
 *
 * Deliberately NOT "does an integration row exist". A tenant who uploaded a CSV
 * has a row whose Google coordinates are empty strings, and a tenant who saved a
 * Drive folder but no spreadsheet has a row that cannot be profiled. Both would
 * pass a row-exists check and then meet a broken step 2.
 */
export function isSourceReady(source: CatalogSource | null | undefined): boolean {
  if (!source) return false;
  if (source.textSource?.kind === "file") {
    // The schema already guarantees a non-empty key and name for this variant;
    // reaching here means a file is stored and readable.
    return true;
  }
  return source.spreadsheetId.trim().length > 0;
}

/** What is still missing, in one sentence. Null when nothing is. */
export function missingSourceReason(source: CatalogSource | null | undefined): string | null {
  if (isSourceReady(source)) return null;
  if (!source) {
    return "Chưa khai nguồn dữ liệu cho đơn vị này.";
  }
  return "Chưa khai bảng Google Sheet — chọn bảng và tab ở trên, hoặc chuyển sang tải file CSV lên.";
}

export interface UploadedFileLine {
  /** "bang-gia-2026.csv" — the name as it was uploaded. */
  readonly fileName: string;
  /** "14:32:07 24/08/2026", or null when the server sent no timestamp. */
  readonly uploadedAt: string | null;
  readonly sizeLabel: string | null;
}

/**
 * "Đang đọc file nào, tải lên lúc nào" — the answer to the question this
 * feature generates on its own.
 *
 * A customer edits the CSV on their laptop, runs a sync, sees the same numbers,
 * and concludes the tool is broken. It is not: the server holds a COPY taken at
 * upload time. The name and the timestamp are the two facts that make that
 * obvious, so they are never abbreviated away.
 */
export function describeUploadedFile(
  textSource: CatalogTextSource | null | undefined,
): UploadedFileLine | null {
  if (textSource?.kind !== "file") return null;

  const uploadedAt =
    typeof textSource.uploadedAt === "string" && textSource.uploadedAt.trim().length > 0
      ? formatDateTime(textSource.uploadedAt)
      : null;

  const sizeLabel =
    typeof textSource.sizeBytes === "number" ? formatFileBytes(textSource.sizeBytes) : null;

  return { fileName: textSource.fileName, uploadedAt, sizeLabel };
}

/** The standing warning that goes with an uploaded file, in one sentence. */
export const UPLOADED_FILE_IS_A_COPY =
  "Hệ thống đọc bản sao đã tải lên, không đọc file trên máy bạn. Sửa file ở máy xong phải tải lên lại thì số mới đổi.";

/**
 * A separator the reader had to GUESS is worth saying out loud; one the file
 * declared or the operator pinned is not. A wrong guess shows up as columns that
 * look shifted, and an operator who was never told a guess happened has no
 * reason to suspect it.
 */
export function describeDelimiter(
  delimiter: string | null,
  detected: boolean,
): string | null {
  if (typeof delimiter !== "string" || delimiter.length === 0) return null;
  const name = delimiterName(delimiter);
  return detected
    ? `Hệ thống tự nhận diện các cột ngăn cách bằng ${name}. Nếu cột hiển thị lệch, xuất lại file hoặc chọn ký tự ngăn cách rồi tải lên lại.`
    : `Các cột ngăn cách bằng ${name}.`;
}

/** Operator-facing name of a separator — "\t" on screen helps nobody. */
export function delimiterName(delimiter: string): string {
  if (delimiter === "\t") return "Tab";
  if (delimiter === ";") return "dấu chấm phẩy (;)";
  if (delimiter === ",") return "dấu phẩy (,)";
  if (delimiter === "|") return "dấu gạch đứng (|)";
  return `“${delimiter}”`;
}
