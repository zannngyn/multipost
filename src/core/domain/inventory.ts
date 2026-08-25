/**
 * Inventory decision table (E3) — brief section 3, CLAUDE.md business rule 3.
 * Pure function, no I/O: the same call runs when a post is composed and again
 * right before the publish API call.
 *
 * Stock is per PRODUCT CODE, not per colour: the catalog keeps one row per code
 * and lists colours in a single cell (docs/05 section 2.4 closes B10).
 *
 * WORDING: operator messages say "bảng dữ liệu" / "dữ liệu sản phẩm", never
 * "Sheet". Since onboarding phase 3 the same row can come from a Google tab, an
 * uploaded CSV or an operator typing it — sending them to a Sheet they may not
 * have is worse than saying nothing.
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
 *
 * THREE POLICIES (onboarding phase 1, `StockPolicy` in catalog-field-map):
 *   numeric  — the table above. Default; nothing changes for existing tenants.
 *   textual  — the tenant writes "Còn hàng" / "Hết" and declares both lists.
 *              A value in neither list BLOCKS: no wording is ever guessed.
 *   disabled — the tenant does not track stock on the sheet. Posting is allowed
 *              WITHOUT a check, which suspends CLAUDE.md business rule 3, so
 *              every decision carries `stockCheckSkipped` + the declared reason.
 *              Never inferred: it only exists when a human wrote it down.
 *
 * The conflict rule and the "HẾT HÀNG" note rule apply in ALL THREE modes.
 */

import {
  DEFAULT_STOCK_POLICY,
  comparisonKey,
  matchStockText,
  validateStockPolicy,
  type StockPolicy,
  type StockPolicyMode,
  type TextualStockPolicy,
} from "./catalog-field-map";
import type { Product } from "./product";

export const INVENTORY_STATUSES = ["in_stock", "low_stock", "blocked"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_BLOCK_REASONS = [
  /** Several catalog rows for one code disagree (docs/05 section 2.5). */
  "SHEET_ROW_CONFLICT",
  /** `Lưu ý` = "HẾT HÀNG". */
  "NOTE_SOLD_OUT",
  /** `Tồn` cell empty. */
  "STOCK_EMPTY",
  /** `Tồn` present but not a number. */
  "STOCK_NOT_A_NUMBER",
  /** `Tồn` = 0 (or negative). */
  "STOCK_ZERO",
  /** Textual policy: the cell says one of the tenant's out-of-stock values. */
  "STOCK_TEXT_OUT_OF_STOCK",
  /** Textual policy: the cell says something the tenant never declared. */
  "STOCK_TEXT_UNKNOWN",
  /** The tenant's stock policy itself is unusable — block instead of guess. */
  "STOCK_POLICY_INVALID",
] as const;
export type InventoryBlockReason = (typeof INVENTORY_BLOCK_REASONS)[number];

/** Threshold from brief section 3: 1..3 posts with an internal warning. */
export const LOW_STOCK_THRESHOLD = 3;

/** Note value that blocks on its own, compared accent- and case-insensitively. */
const SOLD_OUT_NOTE_KEY = comparisonKey("HẾT HÀNG");

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
  /** Which policy produced this decision — for logs and for the UI badge. */
  readonly policyMode: StockPolicyMode;
  /**
   * TRUE means NOBODY checked the stock: the tenant runs `stockPolicy.mode =
   * "disabled"`. Its own flag, not a sentence inside `operatorMessage`, so the
   * UI can paint it red and a log query can count the posts that went out
   * unchecked. `status: "in_stock"` next to this flag does NOT mean "còn hàng".
   */
  readonly stockCheckSkipped: boolean;
  /** The reason the tenant declared when turning the check off. Null otherwise. */
  readonly stockCheckSkippedReason: string | null;
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

export function evaluateInventory(
  input: InventoryInput,
  /** Absent = `numeric`, the behaviour every existing tenant already has. */
  stockPolicy: StockPolicy = DEFAULT_STOCK_POLICY,
): InventoryDecision {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const code = typeof input?.productCode === "string" ? input.productCode.trim() : "";
  const stockRaw = typeof input?.stockRaw === "string" ? input.stockRaw : "";
  const noteRaw = typeof input?.noteRaw === "string" ? input.noteRaw : "";
  const policy = stockPolicy ?? DEFAULT_STOCK_POLICY;

  // A config we cannot read is not a licence to post: block and name it. The
  // adapter validates the JSONB too, so reaching this means a hand-edited row.
  const policyIssues = validateStockPolicy(policy);
  if (policyIssues.length > 0) {
    return blocked(
      "STOCK_POLICY_INVALID",
      null,
      `Mã ${code}: cấu hình kiểm tồn kho của đơn vị không hợp lệ (${policyIssues[0]?.detail ?? ""}) — chặn đăng để an toàn`,
      policy.mode,
    );
  }

  if (input?.hasConflict === true) {
    return blocked(
      "SHEET_ROW_CONFLICT",
      null,
      `Mã ${code} có nhiều dòng dữ liệu mâu thuẫn trong bảng dữ liệu — không đăng, cần sửa bảng dữ liệu trước`,
      policy.mode,
    );
  }

  // Applies in EVERY mode, `disabled` included: an explicit "hết hàng" in the
  // note column is the operator saying so, and out of stock always wins.
  if (comparisonKey(noteRaw) === SOLD_OUT_NOTE_KEY) {
    return blocked(
      "NOTE_SOLD_OUT",
      policy.mode === "numeric" ? parseStock(stockRaw) : null,
      `Mã ${code} đã hết hàng — không đăng`,
      policy.mode,
    );
  }

  if (policy.mode === "disabled") {
    // Allowed WITHOUT a check. The flag below is the whole point: it is how the
    // screen shows red and how a log answers "bài này có kiểm tồn không".
    return {
      status: "in_stock",
      blocked: false,
      reason: null,
      stock: null,
      operatorMessage: `Đơn vị đã tắt kiểm tồn kho — bài đăng KHÔNG được kiểm tra tồn (lý do đã khai: ${policy.reason.trim()})`,
      policyMode: "disabled",
      stockCheckSkipped: true,
      stockCheckSkippedReason: policy.reason.trim(),
    };
  }

  if (policy.mode === "textual") return evaluateTextualStock(code, stockRaw, noteRaw, policy);

  // --- numeric (the default) ----------------------------------------------
  if (stockRaw.trim().length === 0) {
    return blocked(
      "STOCK_EMPTY",
      null,
      `Mã ${code} không có số tồn trong dữ liệu sản phẩm — chặn đăng để an toàn`,
      "numeric",
    );
  }

  const stock = parseStock(stockRaw);
  if (stock === null) {
    return blocked(
      "STOCK_NOT_A_NUMBER",
      null,
      `Mã ${code} có ô Tồn không phải số ("${stockRaw.trim()}") — chặn đăng để an toàn`,
      "numeric",
    );
  }

  if (stock <= 0) {
    return blocked("STOCK_ZERO", stock, `Mã ${code} đã hết hàng — không đăng`, "numeric");
  }

  // --- Allowed ------------------------------------------------------------
  if (stock <= LOW_STOCK_THRESHOLD) {
    return {
      ...allowed("numeric"),
      status: "low_stock",
      stock,
      // Internal warning only — brief section 3 forbids it in captions.
      operatorMessage: `Tồn thấp ${stock}c${noteRaw.trim().length > 0 ? ` — ${noteRaw.trim()}` : ""}`,
    };
  }

  return { ...allowed("numeric"), stock };
}

/**
 * Tenants who write words instead of numbers. Unknown wording BLOCKS: guessing
 * that "sắp về" means "còn hàng" is exactly the mistake that posts a sold-out
 * item, and the tenant can always add the word to their vocabulary.
 */
function evaluateTextualStock(
  code: string,
  stockRaw: string,
  noteRaw: string,
  policy: TextualStockPolicy,
): InventoryDecision {
  if (stockRaw.trim().length === 0) {
    return blocked(
      "STOCK_EMPTY",
      null,
      `Mã ${code} không có giá trị tồn kho trong dữ liệu sản phẩm — chặn đăng để an toàn`,
      "textual",
    );
  }

  const match = matchStockText(policy, stockRaw);
  if (match === "out_of_stock") {
    return blocked(
      "STOCK_TEXT_OUT_OF_STOCK",
      null,
      `Mã ${code} ghi tồn kho là "${stockRaw.trim()}" — nằm trong danh sách HẾT hàng của đơn vị, không đăng`,
      "textual",
    );
  }
  if (match === "unknown") {
    return blocked(
      "STOCK_TEXT_UNKNOWN",
      null,
      `Mã ${code} ghi tồn kho là "${stockRaw.trim()}" — giá trị này chưa được khai báo là còn hay hết hàng, chặn đăng để an toàn`,
      "textual",
    );
  }

  return {
    ...allowed("textual"),
    // No number exists in this mode, so there is no low-stock tier to compute.
    operatorMessage: noteRaw.trim().length > 0 ? noteRaw.trim() : null,
  };
}

function allowed(policyMode: StockPolicyMode): InventoryDecision {
  return {
    status: "in_stock",
    blocked: false,
    reason: null,
    stock: null,
    operatorMessage: null,
    policyMode,
    stockCheckSkipped: false,
    stockCheckSkippedReason: null,
  };
}

function blocked(
  reason: InventoryBlockReason,
  stock: number | null,
  operatorMessage: string,
  policyMode: StockPolicyMode,
): InventoryDecision {
  return {
    status: "blocked",
    blocked: true,
    reason,
    stock,
    operatorMessage,
    policyMode,
    stockCheckSkipped: false,
    stockCheckSkippedReason: null,
  };
}

/** Convenience wrapper for a stored Product. */
export function evaluateProductInventory(
  product: Product,
  /** Absent = `numeric` (backward compatible). */
  stockPolicy: StockPolicy = DEFAULT_STOCK_POLICY,
): InventoryDecision {
  return evaluateInventory(
    {
      productCode: product.content.code,
      stockRaw: product.operational.stockRaw,
      noteRaw: product.operational.noteRaw,
      hasConflict: product.hasConflict,
    },
    stockPolicy,
  );
}
