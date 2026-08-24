/**
 * Which source a tenant's product TEXT is read from (onboarding phase 3).
 * Pure TypeScript: no imports, no I/O (docs/07 section 2).
 *
 * WHY IT IS STORED CONFIG AND NOT A RUNTIME CHOICE: a sync runs on a schedule
 * with nobody watching, so "đọc từ đâu" has to be written down next to the
 * other coordinates in `tenant_integration.config`. A tenant that uploaded a
 * CSV last week must sync from that same file today without touching anything.
 *
 * BACKWARD COMPATIBILITY, same contract as phase 1/2: ABSENT means
 * `google_sheet`. Every row written before phase 3 keeps syncing from its tab,
 * unchanged, and no code path may INFER `file` from anything else.
 */

/** The two readable sources. CSV is the only file format (PM decision). */
export const CATALOG_TEXT_SOURCE_KINDS = ["google_sheet", "file"] as const;
export type CatalogTextSourceKind = (typeof CATALOG_TEXT_SOURCE_KINDS)[number];

/** Reads the tab named by `spreadsheetId`/`sheetName` of the same config. */
export interface GoogleSheetTextConfig {
  readonly kind: "google_sheet";
}

/**
 * Reads a CSV the tenant uploaded. Everything an operator needs to answer "hệ
 * thống đang đọc file nào, tải lên lúc nào" lives here, because that is the
 * first question when they edit the file on their laptop and the numbers do not
 * move (the file on the server is a COPY — editing the local one changes
 * nothing until they upload again).
 */
export interface UploadedFileTextConfig {
  readonly kind: "file";
  /** Opaque handle of `CatalogFileStore`; only the store parses it. */
  readonly storageKey: string;
  /** Name as the operator uploaded it — shown on the sync screen. */
  readonly fileName: string;
  /** Declared MIME type, null when the browser did not say. */
  readonly contentType?: string | null;
  readonly sizeBytes?: number;
  /** ISO-8601 upload time — the other half of "đang đọc file nào". */
  readonly uploadedAt?: string;
  /**
   * Field separator the operator PICKED. Absent = detect it on every read and
   * report what was detected (see the CSV adapter): a locale-exported file can
   * change separator between two uploads, so a stale stored value would be
   * worse than detecting again.
   */
  readonly delimiter?: string | null;
}

export type CatalogTextConfig = GoogleSheetTextConfig | UploadedFileTextConfig;

/** What every tenant configured before phase 3 has, implicitly. */
export const DEFAULT_CATALOG_TEXT_CONFIG: CatalogTextConfig = { kind: "google_sheet" };

export const CATALOG_TEXT_CONFIG_ISSUE_CODES = [
  "TEXT_SOURCE_KIND_INVALID",
  /** `file` without a storage key — nothing could be read. */
  "TEXT_SOURCE_FILE_INCOMPLETE",
] as const;
export type CatalogTextConfigIssueCode = (typeof CATALOG_TEXT_CONFIG_ISSUE_CODES)[number];

export interface CatalogTextConfigIssue {
  readonly code: CatalogTextConfigIssueCode;
  /** Sentence for the operator — Vietnamese. */
  readonly detail: string;
}

/** Returns values, never throws. Empty array = the config is usable. */
export function validateCatalogTextConfig(
  config: CatalogTextConfig | null | undefined,
): readonly CatalogTextConfigIssue[] {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (config === null || config === undefined) return [];

  const kind = (config as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(CATALOG_TEXT_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return [
      {
        code: "TEXT_SOURCE_KIND_INVALID",
        detail: `Nguồn dữ liệu sản phẩm không hợp lệ (${String(kind ?? "trống")}) — chỉ nhận: bảng tính Google hoặc file tải lên.`,
      },
    ];
  }

  if (kind === "google_sheet") return [];

  const file = config as UploadedFileTextConfig;
  const storageKey = typeof file.storageKey === "string" ? file.storageKey.trim() : "";
  const fileName = typeof file.fileName === "string" ? file.fileName.trim() : "";
  if (storageKey.length === 0 || fileName.length === 0) {
    return [
      {
        code: "TEXT_SOURCE_FILE_INCOMPLETE",
        detail:
          "Đơn vị đang đặt nguồn dữ liệu là file tải lên nhưng chưa có file nào được lưu — tải lên lại file .csv bảng sản phẩm.",
      },
    ];
  }

  return [];
}

/**
 * One line naming the source, for the sync screen and the logs. Vietnamese.
 *
 * `sheetName` is passed in because the tab name lives in the other half of the
 * config — and it is the part an operator needs to go and look at the right
 * place, so a message that only said "bảng tính Google" would be a step
 * backwards from what the sync used to print.
 */
export function describeCatalogTextConfig(
  config: CatalogTextConfig | null | undefined,
  sheetName?: string | null,
): string {
  const resolved = config ?? DEFAULT_CATALOG_TEXT_CONFIG;

  if (resolved.kind !== "file") {
    const tab = typeof sheetName === "string" ? sheetName.trim() : "";
    return tab.length > 0 ? `tab '${tab}'` : "bảng tính Google";
  }

  const uploadedAt = typeof resolved.uploadedAt === "string" ? resolved.uploadedAt.trim() : "";
  return uploadedAt.length > 0
    ? `file "${resolved.fileName}" (tải lên lúc ${uploadedAt})`
    : `file "${resolved.fileName}"`;
}
