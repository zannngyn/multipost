import { productStatusVariant, type ProductStatusVariant } from "@/ui/components/products/product-status";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * The written key for the dots in the "Mã SP" column.
 *
 * DESIGN.md, The Named Status Rule: colour is never the only channel. The dot
 * carries an `aria-label` and a tooltip, but neither reaches a sighted operator
 * on a touch screen — hover does not exist there (web-multi-device: a tooltip is
 * never the only home for something that matters). One line of words above the
 * table is the cheap, always-visible answer.
 */
export interface ProductLegendEntry {
  variant: ProductStatusVariant;
  label: string;
}

/**
 * Fixed order, read as a scale: fine · watch · stop.
 *
 * The words are the ones the dots already carry — "Đăng được" and "Tồn thấp"
 * are exactly `productStatus`'s own labels, so the legend and a row's tooltip
 * never call the same colour two different things. Only the error band is
 * generic here: a row names its own reason ("Hết hàng", "Thiếu ảnh"), which is
 * more than a key can say.
 */
export const PRODUCT_LEGEND_ENTRIES: readonly ProductLegendEntry[] = [
  { variant: "success", label: "Đăng được" },
  { variant: "warning", label: "Tồn thấp" },
  { variant: "error", label: "Không đăng được" },
] as const;

/**
 * Only the colours that are actually on screen get explained. A legend naming
 * "Không đăng được" while the filter is "Đăng được" describes rows that are not
 * there, and an operator has to check the table to find that out — noise, and
 * exactly the kind a legend is supposed to remove.
 *
 * Empty input yields an empty legend: the caller renders the empty state, not a
 * key to nothing.
 */
export function legendEntries(items: readonly CatalogProduct[]): readonly ProductLegendEntry[] {
  if (items.length === 0) return [];

  const present = new Set<ProductStatusVariant>(items.map(productStatusVariant));
  return PRODUCT_LEGEND_ENTRIES.filter((entry) => present.has(entry.variant));
}
