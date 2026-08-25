/**
 * THE one place that turns an inventory decision into words.
 *
 * WHY IT EXISTS AT ALL — a tenant may declare `stockPolicy.mode = "disabled"`,
 * which means nobody counted the stock for this catalog. The domain deliberately
 * keeps `status: "in_stock"` in that mode (a fourth enum value would break every
 * zod mirror of that union), so a screen that reads `status` alone prints
 * "Còn hàng" for a code that may well be sold out. That is a business-rule
 * failure — CLAUDE.md rule 3 is suspended for the tenant, and rule 5 says the
 * operator must be able to see it.
 *
 * So: `stockCheckSkipped` is read FIRST, everywhere, and it wins. Reading
 * `inventory.status` directly outside this module is the bug this module exists
 * to prevent.
 *
 * Pure module, no JSX: the catalog table, the catalog inspector and the compose
 * screen all ask the same question, and a `.tsx` that pulls the design system in
 * is the wrong dependency for four comparisons (same reasoning as
 * `products/product-status.ts`).
 */

/**
 * The subset both read models expose — `CatalogProduct["inventory"]`
 * (catalog.schema) and `ComposeResponse["inventory"]` (compose.schema). Declared
 * structurally so this module depends on neither schema file.
 */
export interface StockDecisionView {
  readonly status: "in_stock" | "low_stock" | "blocked";
  /** Null when the source cell was empty or not a number — NOT zero. */
  readonly stock: number | null;
  readonly stockCheckSkipped: boolean;
  readonly stockCheckSkippedReason: string | null;
}

export type StockTone = "success" | "warning" | "danger";

/** Short enough for a table cell, explicit enough to never read as "còn hàng". */
export const STOCK_CHECK_SKIPPED_LABEL = "Không kiểm tồn";

/**
 * Heading of the red banner. Names the risk, and names it NARROWLY.
 *
 * "hệ thống không chặn mã đã hết hàng" is what this used to say, and it was
 * false on the very screen that showed it: the note rule and the row-conflict
 * rule still block in all three policy modes, so a catalog with the gate off can
 * and does contain blocked codes. An operator who reads a warning that is wrong
 * about the screen in front of them cannot answer "vì sao mã này không lên"
 * (CLAUDE.md technical rule 6) — and stops trusting the rest of the sentence.
 *
 * It said "số tồn trên Sheet" until onboarding phase 3, which was the same class
 * of mistake one layer down: the catalog may be a Google tab, an uploaded CSV,
 * or a product typed on the compose screen, and a tenant on either of the last
 * two would go looking for a spreadsheet that does not exist.
 */
export const STOCK_CHECK_SKIPPED_TITLE =
  "Không kiểm tồn kho — số tồn không còn chặn bài nào";

/**
 * The sentence under the title, and the one an operator reads to answer "vì sao
 * mã này không lên". It has to draw the line in the right place, so it names
 * BOTH halves:
 *
 *   what stopped  — the NUMBER. Empty cell, 0, not-a-number: those used to block
 *                   and no longer do. That is the whole of what `disabled` turns
 *                   off, and it is the risk;
 *   what remains  — the sold-out note and a code whose sheet rows disagree.
 *                   Both still block in ALL THREE modes, which is why a catalog
 *                   with the gate off still shows blocked rows.
 *
 * The declared reason is quoted when there is one: "vì sao đơn vị này được
 * phép" is the next question, and it is what makes the warning actionable
 * rather than merely alarming.
 */
export function stockCheckSkippedDescription(reason: string | null): string {
  const base =
    "Đơn vị này đang tắt kiểm tồn kho: ô tồn trống, bằng 0 hay không phải số đều KHÔNG còn chặn nữa — trước đây thì có. Số tồn hiển thị (nếu có) là dữ liệu thô đọc được từ nguồn, không phải kết luận của hệ thống. Vẫn còn chặn như thường: ô Lưu ý ghi “HẾT HÀNG”, và mã có nhiều dòng dữ liệu khác nhau trong cùng một bảng.";
  const tail = " Bật lại trong “Kết nối dữ liệu” › bước “Ánh xạ cột & kiểm tồn”.";
  const written = typeof reason === "string" ? reason.trim() : "";
  return written.length > 0 ? `${base} Lý do đã khai: “${written}”.${tail}` : `${base}${tail}`;
}

export interface StockLabelView {
  /** The words next to the number. Colour is never the only channel. */
  readonly label: string;
  readonly tone: StockTone;
  /** True when nobody checked — the caller must also show the red banner. */
  readonly isSkipped: boolean;
}

const STATUS_LABELS: Record<StockDecisionView["status"], string> = {
  in_stock: "Còn hàng",
  low_stock: "Tồn thấp",
  blocked: "Bị chặn",
};

const STATUS_TONES: Record<StockDecisionView["status"], StockTone> = {
  in_stock: "success",
  low_stock: "warning",
  blocked: "danger",
};

/**
 * Guard clause first: skipped beats every status, including `blocked`.
 *
 * `blocked` while the check is off is not a contradiction — the row-conflict
 * rule and the "HẾT HÀNG" note still block in all three policy modes — but such
 * a row is still one nobody counted, so the honest word stays the same.
 */
export function stockLabel(inventory: StockDecisionView | null | undefined): StockLabelView {
  if (!inventory) {
    // No decision at all (compose could not read one). "Chưa đọc được" is
    // neither "còn hàng" nor "hết hàng"; saying either would invent an answer.
    return { label: "Chưa đọc được tồn", tone: "warning", isSkipped: false };
  }

  if (inventory.stockCheckSkipped) {
    return { label: STOCK_CHECK_SKIPPED_LABEL, tone: "danger", isSkipped: true };
  }

  return {
    label: STATUS_LABELS[inventory.status],
    tone: STATUS_TONES[inventory.status],
    isSkipped: false,
  };
}

/**
 * The stock CELL of a table: the number, or the reason there is none.
 * Never "0" for an empty cell — that would read as a counted zero.
 */
export function stockCellText(inventory: StockDecisionView | null | undefined): string {
  if (!inventory) return "—";
  if (inventory.stockCheckSkipped) return STOCK_CHECK_SKIPPED_LABEL;
  if (inventory.stock === null) return "—";
  return new Intl.NumberFormat("vi-VN").format(inventory.stock);
}

/** True when any row on screen was decided without a stock check. */
export function hasSkippedStockCheck(
  rows: readonly { readonly inventory: StockDecisionView }[],
): boolean {
  return rows.some((row) => row.inventory.stockCheckSkipped);
}

/**
 * The reason to quote in a screen-level banner: the first one actually written.
 * Every row of a tenant carries the same policy, but a null on the first row
 * must not silence a reason present on the rest.
 */
export function firstSkippedReason(
  rows: readonly { readonly inventory: StockDecisionView }[],
): string | null {
  for (const row of rows) {
    if (!row.inventory.stockCheckSkipped) continue;
    const reason = row.inventory.stockCheckSkippedReason?.trim() ?? "";
    if (reason.length > 0) return reason;
  }
  return null;
}
