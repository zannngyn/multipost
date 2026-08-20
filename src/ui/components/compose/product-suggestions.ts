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
    name: product.name.trim().length > 0 ? product.name : "(chưa có tên trên Sheet)",
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
  if (product.inventory.status === "blocked") return outOfStockMessage(product.code);
  if (product.composable) return null;
  return product.blockedReason?.userMessage ?? UNSPECIFIED_BLOCK;
}

function describeMeta(product: CatalogProduct): string {
  const parts: string[] = [];

  if (product.inventory.status === "blocked") parts.push("hết hàng");
  else if (product.inventory.stock === null) parts.push("chưa có số tồn");
  else parts.push(`tồn ${product.inventory.stock}`);

  const media = product.mediaImageCount + product.mediaVideoCount;
  parts.push(media === 0 ? "chưa có file" : `${media} file`);

  return parts.join(" · ");
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
