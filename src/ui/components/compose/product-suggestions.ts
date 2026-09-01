import { stockLabel } from "@/ui/components/inventory/stock-check";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * Turning a catalog row into one line of the product suggestion list.
 *
 * Pure on purpose: "may this code be composed, and what do we say when it may
 * not" is the one decision on this screen that must be testable without a DOM.
 *
 * The stock gate itself lives on the server and runs TWICE (business rule 3).
 * What happens here is earlier and cheaper: an out-of-stock code is refused in
 * the picker so the operator never gets as far as writing a caption for a post
 * that cannot go out.
 */

export interface ProductSuggestion {
  readonly code: string;
  readonly name: string;
  /** Short right-hand metadata: stock, then how many photos are on Drive. */
  readonly meta: string;
  /** True = the row is announced and drawn as unavailable, and cannot be picked. */
  readonly disabled: boolean;
  /** Why it cannot be picked. Null when it can. */
  readonly blockedMessage: string | null;
}

/**
 * The exact sentence the operator must see for an out-of-stock code. Kept as a
 * function so the wording exists once, not once per screen.
 */
export function outOfStockMessage(code: string): string {
  return `Mã ${code} đã hết hàng — không đăng`;
}

/** Fallback when the server refused a code without saying why. */
const UNSPECIFIED_BLOCK = "Mã này chưa đăng được. Mở màn Sản phẩm để xem lý do chi tiết.";

export function toProductSuggestion(product: CatalogProduct): ProductSuggestion {
  const blockedMessage = describeBlock(product);

  return {
    code: product.code,
    // "trong dữ liệu", not "trên Sheet": the row may have come from a Google
    // tab, an uploaded CSV, or a product typed on this screen.
    name: product.name.trim().length > 0 ? product.name : "(chưa có tên trong dữ liệu)",
    meta: describeMeta(product),
    // `composable` is the SERVER's verdict; the UI never re-derives "đăng được"
    // from the parts, it only explains the verdict it was given.
    disabled: blockedMessage !== null,
    blockedMessage,
  };
}

/**
 * Out of stock is called out by name because it is the one refusal an operator
 * can act on immediately (chọn mã khác). Everything else keeps the server's own
 * sentence rather than being flattened into "không đăng được".
 */
function describeBlock(product: CatalogProduct): string | null {
  // A blocked decision refuses the row, always — that check must not start
  // depending on `composable`, or a disagreement between the two fields would
  // put an un-postable code back in the picker.
  if (product.inventory.status === "blocked") {
    // Only the WORDING depends on the policy: with the stock gate off, the
    // refusal came from the sold-out note or from two sheet rows disagreeing,
    // never from a count, so the mandated "đã hết hàng" sentence would send the
    // operator to fix a cell nobody reads. The server's own reason says which
    // rule refused it.
    return product.inventory.stockCheckSkipped
      ? (product.blockedReason?.userMessage ?? UNSPECIFIED_BLOCK)
      : outOfStockMessage(product.code);
  }
  if (product.composable) return null;
  return product.blockedReason?.userMessage ?? UNSPECIFIED_BLOCK;
}

/**
 * The right-hand metadata of one row.
 *
 * Stock goes through `stockLabel`, which reads `stockCheckSkipped` BEFORE
 * `status`. Reading `status` here was the last place in the UI that interpreted
 * an inventory decision on its own: with the gate off every row printed "chưa có
 * số tồn", which is not a lie but hides the fact that nobody counted — and it
 * disagreed with the catalog table, the inspector and the compose line, which
 * all say "không kiểm tồn". One vocabulary, one module.
 */
function describeMeta(product: CatalogProduct): string {
  const parts: string[] = [];
  const stock = stockLabel(product.inventory);

  if (stock.isSkipped) parts.push("không kiểm tồn");
  else if (product.inventory.status === "blocked") parts.push("hết hàng");
  else if (product.inventory.stock === null) parts.push("chưa có số tồn");
  else parts.push(`tồn ${product.inventory.stock}`);

  const media = product.mediaImageCount + product.mediaVideoCount;
  parts.push(media === 0 ? "chưa có file" : `${media} file`);

  return parts.join(" · ");
}

/**
 * The rows the picker may actually OFFER.
 *
 * The query already asks the catalog for `status: "ok"`, so this is the second
 * of two gates, and it is deliberate: `composable` is decided by the usecase,
 * `describeBlock` above is decided here, and the two are different code. If they
 * ever disagree the safe answer is to drop the row — a suggestion that cannot be
 * posted costs the operator a click and teaches nothing.
 */
export function selectableSuggestions(
  products: readonly CatalogProduct[],
): readonly ProductSuggestion[] {
  return products.map(toProductSuggestion).filter((item) => !item.disabled);
}

export interface SuggestionEmptyState {
  readonly title: string;
  readonly hint: string;
}

/**
 * What an empty dropdown says.
 *
 * THREE answers, not one, because they send the operator to three different
 * places: nothing synced at all, nothing matched the search, or things matched
 * and every one of them is blocked. Collapsing the third into "không có mã nào
 * khớp" is a sentence the product screen then contradicts.
 *
 * `hiddenCount` is read FIRST: it is the only branch that can be true while the
 * search did match, so testing the query first would hide it.
 */
export function suggestionEmptyState(query: string, hiddenCount: number): SuggestionEmptyState {
  const q = query.trim();

  if (hiddenCount > 0) {
    return {
      title: "Không có mã nào đăng được",
      hint: `${hiddenCount} mã đang vướng (hết hàng, thiếu ảnh, hoặc dữ liệu lệch nhau) nên không hiện ở đây. Mở màn Sản phẩm để xem lý do từng mã.`,
    };
  }
  if (q.length === 0) {
    return {
      title: "Danh mục đang trống",
      hint: "Chạy đồng bộ dữ liệu ở màn Sản phẩm, hoặc gõ thẳng mã nếu bạn biết chắc.",
    };
  }
  return {
    title: `Không có mã nào khớp “${q}”`,
    hint: "Mã vừa thêm vào bảng dữ liệu mà chưa đồng bộ vẫn gõ thẳng được — hệ thống sẽ tra lại khi bạn bấm nút.",
  };
}

/**
 * The line under the list.
 *
 * It exists because the list is FILTERED and a filtered list that does not say
 * so reads as "chỉ có ngần này mã" — the operator then goes hunting for a code
 * that is in the catalog but cannot be posted. It names the page size too: "khớp
 * 120 mã" over eight visible rows is otherwise read as a broken list.
 */
export function suggestionFooterText(
  okCount: number,
  hiddenCount: number,
  limit: number,
): string {
  const hidden = hiddenCount > 0 ? `, ẩn ${hiddenCount} mã đang vướng (xem ở màn Sản phẩm)` : "";
  return (
    `Danh sách chỉ gợi ý mã đăng được, tối đa ${limit} mã một lần. ` +
    `Khớp ${okCount} mã đăng được${hidden}. Mã chưa đồng bộ vẫn gõ thẳng được.`
  );
}

/**
 * Where the highlight goes on ↓ / ↑.
 *
 * Wraps at both ends (core-form-inputs §bàn phím) and answers -1 for an empty
 * list, so a keypress on an empty dropdown cannot select a row that is not there.
 */
export function nextHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + (delta % length) + length) % length;
}
