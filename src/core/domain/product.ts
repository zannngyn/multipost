/**
 * Product + MediaAsset domain (E2/E3).
 * Pure TypeScript: no imports outside core/domain (docs/07 section 2).
 *
 * The type split is the whitelist (brief section 2.2, CLAUDE.md business rule 2):
 *
 *   ProductContent      — name, description, category, season. The ONLY fields
 *                         allowed to reach a prompt or a public caption.
 *   ProductOperational  — stock, note, prices. Internal-only, must never leave
 *                         the data layer.
 *
 * They are two separate types on purpose: a caption builder that only accepts
 * `ProductContent` cannot receive a price even by accident. `Product` glues them
 * together for the data layer, and `toPromptInput()` is the single documented
 * door from one to the other.
 */

import { normalizeProductCode, type MediaKind, type MediaVariantFlags } from "./media-file-name";

// --- Sheet columns ----------------------------------------------------------

/**
 * Exact column headers of tab "Mẫu 2026" (docs/05 section 2.1). Columns are read
 * BY NAME, never by position — a reordered sheet must not shift the data, and a
 * renamed column must raise schema drift instead of being guessed.
 */
export const SHEET_COLUMNS = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: "Mô tả sản phẩm",
  category: "Chủng loại",
  season: "Mùa vụ",
  stock: "Tồn",
  note: "Lưu ý nhận sx 1c / sx hết tồn",
  colors: "Màu sắc",
} as const;

/** Without these the row cannot be used at all. */
export const REQUIRED_SHEET_COLUMNS: readonly string[] = [SHEET_COLUMNS.code, SHEET_COLUMNS.name];

/**
 * Columns that must never be read into a Product, let alone a prompt. Listed so
 * the guard is explicit and testable rather than a convention someone forgets.
 */
export const FORBIDDEN_SHEET_COLUMNS: readonly string[] = [
  "Nguyên Giá (bắt buộc)",
  "Giá TMĐT",
  "Giá TMĐT làm tròn",
  "Giá KM",
];

// --- Product ----------------------------------------------------------------

/** Caption-safe fields. Whitelist of brief section 2.2 — do not extend lightly. */
export interface ProductContent {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly season: string | null;
}

/**
 * Internal-only fields. Never passed to core/ai, never rendered in a caption.
 * Prices are typed here so that any future code touching them is visibly in the
 * operational half — sync-catalog deliberately does NOT persist them.
 */
export interface ProductOperational {
  /** `Tồn` exactly as the sheet wrote it (may be "", " 3 ", or junk). */
  readonly stockRaw: string;
  /** `Lưu ý nhận sx 1c / sx hết tồn` as written. */
  readonly noteRaw: string;
  /** `Màu sắc` as written ("KEM, HỒNG"). Informational: stock is per code. */
  readonly colorsRaw: string;
  /** Prices — read only if a future feature needs them; never persisted today. */
  readonly prices?: Readonly<Record<string, string>>;
}

export interface Product {
  readonly content: ProductContent;
  readonly operational: ProductOperational;
  /**
   * True when the code appears on several sheet rows with conflicting data
   * (docs/05 section 2.5, MGKSQ6031). Posting is blocked until a human fixes it.
   */
  readonly hasConflict: boolean;
  /** 1-based sheet row numbers this product was built from. */
  readonly sourceRows: readonly number[];
}

/**
 * The ONLY way content crosses into the AI layer. Returns a fresh object so a
 * caller cannot reach the operational half through a shared reference.
 */
export function toPromptInput(product: Product): ProductContent {
  const { code, name, description, category, season } = product.content;
  return { code, name, description, category, season };
}

// --- MediaAsset -------------------------------------------------------------

/** Where an asset's bytes come from. Mirrors the `media_origin` DB enum. */
export const MEDIA_ORIGINS = ["drive", "upload"] as const;
export type MediaOrigin = (typeof MEDIA_ORIGINS)[number];

export interface MediaAsset {
  /**
   * Asset identity. A Drive file id for a synced asset (names repeat, ids do
   * not); a generated `upload_<hex>` for one the operator supplied (E9).
   */
  readonly driveFileId: string;
  /** Which of the two modes produced this asset. */
  readonly origin: MediaOrigin;
  /** Handle into MediaBlobStore. Null unless `origin` is "upload". */
  readonly storageKey: string | null;
  readonly fileName: string;
  readonly productCode: string;
  readonly color: string | null;
  readonly colorRaw: string | null;
  readonly sequence: number | null;
  readonly kind: MediaKind;
  readonly variants: MediaVariantFlags;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  /** Drive `modifiedTime`, ISO-8601. Used to pick a winner among duplicates. */
  readonly modifiedTime: string | null;
  /** File-name deviations, kept so the UI can explain a "needs review" badge. */
  readonly warnings: readonly string[];
  readonly needsReview: boolean;
}

/**
 * Duplicate names are real: 1,499 names appear twice or more with different file
 * ids (docs/05 section 1.4). Rule: newest `modifiedTime` wins; ties fall back to
 * the file id so the outcome is deterministic across syncs.
 */
export function dedupeMediaByName(assets: readonly MediaAsset[]): {
  kept: MediaAsset[];
  dropped: MediaAsset[];
} {
  const bestByName = new Map<string, MediaAsset>();
  const dropped: MediaAsset[] = [];

  for (const asset of assets) {
    const key = `${asset.productCode}::${asset.fileName.trim().toUpperCase()}`;
    const current = bestByName.get(key);
    if (!current) {
      bestByName.set(key, asset);
      continue;
    }
    const winner = pickNewer(current, asset);
    bestByName.set(key, winner);
    dropped.push(winner === current ? asset : current);
  }

  return { kept: [...bestByName.values()], dropped };
}

function pickNewer(a: MediaAsset, b: MediaAsset): MediaAsset {
  const timeA = a.modifiedTime ? Date.parse(a.modifiedTime) : Number.NaN;
  const timeB = b.modifiedTime ? Date.parse(b.modifiedTime) : Number.NaN;
  const validA = Number.isFinite(timeA);
  const validB = Number.isFinite(timeB);

  if (validA && validB && timeA !== timeB) return timeA > timeB ? a : b;
  if (validA !== validB) return validA ? a : b;
  // No usable timestamps (or an exact tie): deterministic fallback.
  return a.driveFileId >= b.driveFileId ? a : b;
}

// --- Sheet row -> Product ---------------------------------------------------

export const SHEET_ROW_ISSUES = ["MISSING_CODE", "MALFORMED_CODE", "MISSING_NAME"] as const;
export type SheetRowIssue = (typeof SHEET_ROW_ISSUES)[number];

export type ParsedSheetRow =
  | { readonly ok: true; readonly value: Product }
  | {
      readonly ok: false;
      readonly issue: SheetRowIssue;
      readonly rowNumber: number;
      readonly detail: string;
    };

function cell(values: Readonly<Record<string, string>>, column: string): string {
  const value = values[column];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Maps one already-validated sheet row onto a Product. Returns a value on
 * failure — a broken row must not abort the whole sync (business rule 5).
 */
export function parseSheetRow(
  rowNumber: number,
  values: Readonly<Record<string, string>>,
): ParsedSheetRow {
  // --- Edge cases first ----------------------------------------------------
  const rawCode = cell(values, SHEET_COLUMNS.code);
  if (rawCode.length === 0) {
    return {
      ok: false,
      issue: "MISSING_CODE",
      rowNumber,
      // Operator-facing sentence (CLAUDE.md rule 6): Vietnamese, keeps the row
      // number and the column name so the fix can be found on the Sheet.
      detail: `Dòng ${rowNumber}: ô '${SHEET_COLUMNS.code}' đang trống — điền mã sản phẩm rồi đồng bộ lại.`,
    };
  }

  const code = normalizeProductCode(rawCode);
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) {
    return {
      ok: false,
      issue: "MALFORMED_CODE",
      rowNumber,
      detail: `Dòng ${rowNumber}: mã sản phẩm '${rawCode}' không dùng được (chỉ chấp nhận 4-20 ký tự chữ HOA, số hoặc '-') — sửa lại mã trên Sheet.`,
    };
  }

  const name = cell(values, SHEET_COLUMNS.name);
  if (name.length === 0) {
    // The name opens every caption (brief 7.3) — a row without one is unusable.
    return {
      ok: false,
      issue: "MISSING_NAME",
      rowNumber,
      detail: `Dòng ${rowNumber} (${code}): ô '${SHEET_COLUMNS.name}' đang trống — caption mở đầu bằng tên sản phẩm nên dòng này chưa dùng được.`,
    };
  }

  const description = cell(values, SHEET_COLUMNS.description);
  const category = cell(values, SHEET_COLUMNS.category);
  const season = cell(values, SHEET_COLUMNS.season);

  return {
    ok: true,
    value: {
      content: {
        code,
        name,
        description: description.length > 0 ? description : null,
        category: category.length > 0 ? category : null,
        season: season.length > 0 ? season : null,
      },
      operational: {
        stockRaw: cell(values, SHEET_COLUMNS.stock),
        noteRaw: cell(values, SHEET_COLUMNS.note),
        colorsRaw: cell(values, SHEET_COLUMNS.colors),
      },
      hasConflict: false,
      sourceRows: [rowNumber],
    },
  };
}

/**
 * Same code on several rows (docs/05 section 2.5). Identical rows are a plain
 * duplicate and collapse silently; anything that differs in a field we use is a
 * conflict -> `hasConflict`, which blocks posting instead of picking a winner.
 */
export function mergeDuplicateProducts(a: Product, b: Product): Product {
  const sourceRows = [...new Set([...a.sourceRows, ...b.sourceRows])].sort((x, y) => x - y);
  const conflict = a.hasConflict || b.hasConflict || !sameProductData(a, b);
  return { ...a, hasConflict: conflict, sourceRows };
}

function sameProductData(a: Product, b: Product): boolean {
  return (
    a.content.name === b.content.name &&
    a.content.description === b.content.description &&
    a.content.category === b.content.category &&
    a.content.season === b.content.season &&
    a.operational.stockRaw === b.operational.stockRaw &&
    a.operational.noteRaw === b.operational.noteRaw &&
    a.operational.colorsRaw === b.operational.colorsRaw
  );
}
