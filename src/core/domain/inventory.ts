/**
 * Inventory decision table (E3) — brief section 3, CLAUDE.md business rule 3.
 * Pure function, no I/O: the same call runs when a post is composed and again
 * right before the publish API call.
 *
 * Stock is per PRODUCT CODE, not per colour: the sheet keeps one row per code
 * and lists colours in a single cell (docs/05 section 2.4 closes B10).
 *
 * Decision table, first match wins:
 *
 *   1. sheet row conflict          -> blocked  (never guess between two rows)
 *   2. note = "HẾT HÀNG"           -> blocked
 *   3. stock cell empty            -> blocked  (safe default; 5 real rows)
 *   4. stock not a number          -> blocked  (safe default)
 *   5. stock <= 0                  -> blocked
 *   6. stock 1..3                  -> allowed + internal low-stock warning
 *   7. stock > 3                   -> allowed
 *
 * "Out of stock wins" is explicit in the brief: `Tồn = 0` blocks whatever the
 * note says, and the note blocks whatever the number says.
 */

import type { Product } from "./product";

export const INVENTORY_STATUSES = ["in_stock", "low_stock", "blocked"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_BLOCK_REASONS = [
  /** Several sheet rows for one code disagree (docs/05 section 2.5). */
  "SHEET_ROW_CONFLICT",
  /** `Lưu ý` = "HẾT HÀNG". */
  "NOTE_SOLD_OUT",
  /** `Tồn` cell empty. */
  "STOCK_EMPTY",
  /** `Tồn` present but not a number. */
  "STOCK_NOT_A_NUMBER",
  /** `Tồn` = 0 (or negative). */
  "STOCK_ZERO",
] as const;
export type InventoryBlockReason = (typeof INVENTORY_BLOCK_REASONS)[number];

/** Threshold from brief section 3: 1..3 posts with an internal warning. */
export const LOW_STOCK_THRESHOLD = 3;

/** Note value that blocks on its own, compared accent- and case-insensitively. */
const SOLD_OUT_NOTE_KEY = "HETHANG";

export interface InventoryDecision {
  readonly status: InventoryStatus;
  readonly blocked: boolean;
  /** Set only when blocked. */
  readonly reason: InventoryBlockReason | null;
  /** Parsed stock, null when unusable. */
  readonly stock: number | null;
  /**
   * Internal-only operator message (brief section 3: never in a caption).
   * Vietnamese because an operator reads it on screen.
   */
  readonly operatorMessage: string | null;
}

export interface InventoryInput {
  readonly productCode: string;
  /** `Tồn` exactly as the sheet wrote it. */
  readonly stockRaw: string;
  /** `Lưu ý nhận sx 1c / sx hết tồn` exactly as the sheet wrote it. */
  readonly noteRaw: string;
  /** True when the code has conflicting sheet rows. */
  readonly hasConflict?: boolean;
}

/** Accent/case-insensitive comparison key. Local copy keeps this file dependency-free. */
function noteKey(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Strict numeric parse. `Number("")` is 0 and `parseInt("3 cái")` is 3 — both
 * would post an out-of-stock item, so neither is acceptable here.
 * Accepts "1.234" / "1,234" thousand separators seen in spreadsheets.
 */
function parseStock(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Plain integer, or an integer with 3-digit groups ("1.234"). "3.5" is NOT a
  // thousand separator — reading it as 35 would post an almost-empty item.
  if (!/^-?\d{1,3}([.,]\d{3})*$/.test(trimmed) && !/^-?\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed.replace(/[.,]/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}

export function evaluateInventory(input: InventoryInput): InventoryDecision {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const code = typeof input?.productCode === "string" ? input.productCode.trim() : "";
  const stockRaw = typeof input?.stockRaw === "string" ? input.stockRaw : "";
  const noteRaw = typeof input?.noteRaw === "string" ? input.noteRaw : "";

  if (input?.hasConflict === true) {
    return blocked(
      "SHEET_ROW_CONFLICT",
      null,
      `Mã ${code} có nhiều dòng dữ liệu mâu thuẫn trên Sheet — không đăng, cần sửa Sheet trước`,
    );
  }

  if (noteKey(noteRaw) === SOLD_OUT_NOTE_KEY) {
    return blocked("NOTE_SOLD_OUT", parseStock(stockRaw), `Mã ${code} đã hết hàng — không đăng`);
  }

  if (stockRaw.trim().length === 0) {
    return blocked(
      "STOCK_EMPTY",
      null,
      `Mã ${code} không có số tồn trên Sheet — chặn đăng để an toàn`,
    );
  }

  const stock = parseStock(stockRaw);
  if (stock === null) {
    return blocked(
      "STOCK_NOT_A_NUMBER",
      null,
      `Mã ${code} có ô Tồn không phải số ("${stockRaw.trim()}") — chặn đăng để an toàn`,
    );
  }

  if (stock <= 0) {
    return blocked("STOCK_ZERO", stock, `Mã ${code} đã hết hàng — không đăng`);
  }

  // --- Allowed ------------------------------------------------------------
  if (stock <= LOW_STOCK_THRESHOLD) {
    return {
      status: "low_stock",
      blocked: false,
      reason: null,
      stock,
      // Internal warning only — brief section 3 forbids it in captions.
      operatorMessage: `Tồn thấp ${stock}c${noteRaw.trim().length > 0 ? ` — ${noteRaw.trim()}` : ""}`,
    };
  }

  return { status: "in_stock", blocked: false, reason: null, stock, operatorMessage: null };
}

function blocked(
  reason: InventoryBlockReason,
  stock: number | null,
  operatorMessage: string,
): InventoryDecision {
  return { status: "blocked", blocked: true, reason, stock, operatorMessage };
}

/** Convenience wrapper for a stored Product. */
export function evaluateProductInventory(product: Product): InventoryDecision {
  return evaluateInventory({
    productCode: product.content.code,
    stockRaw: product.operational.stockRaw,
    noteRaw: product.operational.noteRaw,
    hasConflict: product.hasConflict,
  });
}
