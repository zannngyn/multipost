import type { CatalogProductTotals, ProductFilter } from "@/ui/schemas/catalog.schema";

/**
 * How many products the ACTIVE filter matches — the honest denominator for
 * "đang hiển thị N / M".
 *
 * The API narrows `totals` by the search term but NOT by status: all three
 * counts stay available so the segmented control can label its own tabs. So the
 * denominator is the count for the selected status, never `totals.total`, which
 * would read "20 / 299" while the list is filtered down to 20.
 */
export function matchingTotal(totals: CatalogProductTotals, filter: ProductFilter): number {
  if (filter.status === "ok") return totals.ok;
  if (filter.status === "blocked") return totals.blocked;
  return totals.total;
}
