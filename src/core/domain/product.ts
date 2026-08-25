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

import {
  FIELD_LABELS,
  MYSP_FIELD_MAP,
  MYSP_PRICE_COLUMNS,
  type CatalogFieldMap,
} from "./catalog-field-map";
import { normalizeProductCode, type MediaKind, type MediaVariantFlags } from "./media-file-name";

// --- Sheet columns ----------------------------------------------------------

/**
 * Exact column headers of tab "Mẫu 2026" (docs/05 section 2.1) — the INTERNAL
 * company's sheet. Columns are read BY NAME, never by position.
 *
 * Since the onboarding work this is no longer the source of truth: it is a view
 * of `MYSP_FIELD_MAP`, the default field map. A tenant with a different sheet
 * carries its own map in `tenant_integration.config` (see catalog-field-map).
 */
export const SHEET_COLUMNS = {
  code: MYSP_FIELD_MAP.code,
  name: MYSP_FIELD_MAP.name,
  description: MYSP_FIELD_MAP.description,
  category: MYSP_FIELD_MAP.category,
  season: MYSP_FIELD_MAP.season,
  stock: MYSP_FIELD_MAP.stock,
  note: MYSP_FIELD_MAP.note,
  colors: MYSP_FIELD_MAP.colors,
} as const;

/** Without these the row cannot be used at all — for the MYSP preset. */
export const REQUIRED_SHEET_COLUMNS: readonly string[] = [SHEET_COLUMNS.code, SHEET_COLUMNS.name];

/**
 * @deprecated Renamed to `MYSP_PRICE_COLUMNS` and demoted to an onboarding
 * HINT. It never was a general guard: it lists four headers of one sheet, so it
 * could not protect a customer sheet nobody has seen. The real guarantee is the
 * opt-in map — `parseSheetRow` reads only mapped columns, so an unmapped price
 * column cannot reach `ProductContent`. Kept as an alias for existing callers.
 */
export const FORBIDDEN_SHEET_COLUMNS: readonly string[] = MYSP_PRICE_COLUMNS;

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

/**
 * Where a product's TEXT came from. Mirrors the `product_origin` DB enum.
 *
 * `sheet` = a synced catalog row (Google tab or uploaded CSV — both arrive as
 * the same snapshot). `manual` = typed by an operator on the compose screen
 * (onboarding phase 3), for a tenant who has no importable catalog at all.
 *
 * It is stored, not derived: months later "vì sao bài này có dữ liệu như vậy"
 * must be answerable, and a sync must know which rows it may sweep.
 */
export const PRODUCT_ORIGINS = ["sheet", "manual"] as const;
export type ProductOrigin = (typeof PRODUCT_ORIGINS)[number];

export interface Product {
  readonly content: ProductContent;
  readonly operational: ProductOperational;
  /**
   * Absent = `sheet`. Optional so every existing snapshot/fixture keeps its
   * meaning unchanged; read it through `productOrigin()` rather than directly.
   */
  readonly origin?: ProductOrigin;
  /**
   * True when the code appears on several sheet rows with conflicting data
   * (docs/05 section 2.5, MGKSQ6031). Posting is blocked until a human fixes it.
   */
  readonly hasConflict: boolean;
  /** 1-based sheet row numbers this product was built from. */
  readonly sourceRows: readonly number[];
}

/** Origin of a product, with the historical default for rows without one. */
export function productOrigin(product: Product | null | undefined): ProductOrigin {
  return product?.origin === "manual" ? "manual" : "sheet";
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

export const SHEET_ROW_ISSUES = [
  "MISSING_CODE",
  "MALFORMED_CODE",
  "MISSING_NAME",
  /** The tenant's field map has no column for `code`/`name` (defence in depth). */
  "FIELD_MAP_INCOMPLETE",
] as const;
export type SheetRowIssue = (typeof SHEET_ROW_ISSUES)[number];

export type ParsedSheetRow =
  | { readonly ok: true; readonly value: Product }
  | {
      readonly ok: false;
      readonly issue: SheetRowIssue;
      readonly rowNumber: number;
      readonly detail: string;
    };

/**
 * Reads ONE mapped column. A null column (field not mapped by this tenant) is
 * an empty value — never a lookup by position, never a guess. This is what
 * makes the whitelist opt-in: an unmapped column is invisible to the parser.
 */
function cell(values: Readonly<Record<string, string>>, column: string | null): string {
  if (typeof column !== "string" || column.length === 0) return "";
  const value = values[column];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Maps one already-validated sheet row onto a Product. Returns a value on
 * failure — a broken row must not abort the whole sync (business rule 5).
 *
 * `fieldMap` is optional: without it the row is read with the internal
 * company's headers (`MYSP_FIELD_MAP`), exactly as before this parameter
 * existed. Operator messages always name the CALLER's column, never ours.
 */
export function parseSheetRow(
  rowNumber: number,
  values: Readonly<Record<string, string>>,
  fieldMap: CatalogFieldMap = MYSP_FIELD_MAP,
): ParsedSheetRow {
  // --- Edge cases first ----------------------------------------------------
  const map = fieldMap ?? MYSP_FIELD_MAP;
  const codeColumn = typeof map.code === "string" && map.code.length > 0 ? map.code : null;
  const nameColumn = typeof map.name === "string" && map.name.length > 0 ? map.name : null;
  if (codeColumn === null || nameColumn === null) {
    // sync-catalog refuses such a map before it gets here; this branch exists so
    // a hand-edited config can never be read as "every row is empty".
    const missing = [codeColumn === null ? FIELD_LABELS.code : null, nameColumn === null ? FIELD_LABELS.name : null]
      .filter((label): label is string => label !== null)
      .join(", ");
    return {
      ok: false,
      issue: "FIELD_MAP_INCOMPLETE",
      rowNumber,
      detail: `Chưa khai báo cột nguồn cho: ${missing}. Vào phần cấu hình nguồn dữ liệu để chọn cột tương ứng trên bảng tính.`,
    };
  }

  const rawCode = cell(values, codeColumn);
  if (rawCode.length === 0) {
    return {
      ok: false,
      issue: "MISSING_CODE",
      rowNumber,
      // Operator-facing sentence (CLAUDE.md rule 6): Vietnamese, keeps the row
      // number and the column name so the fix can be found on the Sheet.
      detail: `Dòng ${rowNumber}: ô '${codeColumn}' đang trống — điền mã sản phẩm rồi đồng bộ lại.`,
    };
  }

  const code = normalizeProductCode(rawCode);
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) {
    return {
      ok: false,
      issue: "MALFORMED_CODE",
      rowNumber,
      detail: `Dòng ${rowNumber}: mã sản phẩm '${rawCode}' không dùng được (chỉ chấp nhận 4-20 ký tự chữ HOA, số hoặc '-') — sửa lại mã trong bảng dữ liệu.`,
    };
  }

  const name = cell(values, nameColumn);
  if (name.length === 0) {
    // The name opens every caption (brief 7.3) — a row without one is unusable.
    return {
      ok: false,
      issue: "MISSING_NAME",
      rowNumber,
      detail: `Dòng ${rowNumber} (${code}): ô '${nameColumn}' đang trống — caption mở đầu bằng tên sản phẩm nên dòng này chưa dùng được.`,
    };
  }

  // Only the four mapped content columns are read here — the operational half
  // below is read from its own mapped columns and never crosses over.
  const description = cell(values, map.description);
  const category = cell(values, map.category);
  const season = cell(values, map.season);

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
        stockRaw: cell(values, map.stock),
        noteRaw: cell(values, map.note),
        colorsRaw: cell(values, map.colors),
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
