import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * What the inspector (panel on wide screens, drawer below 1024px) has to show.
 *
 * `?chon=` is a free-form string from the address bar, so "there is a selected
 * code" and "that code is on screen" are two different facts. Collapsing them
 * into `product | null` — what this screen used to do — made a shared link to a
 * code that the current filter hides render "Chưa chọn sản phẩm nào", i.e. the
 * app quietly denying the operator ever asked (business rule 5: nothing is
 * silently skipped).
 */
export type ProductInspectorState =
  | { kind: "none" }
  | { kind: "loading"; code: string }
  | { kind: "missing"; code: string }
  | { kind: "product"; product: CatalogProduct };

/**
 * Resolves `?chon=` against the rows that are actually loaded.
 *
 * Edge cases, in order: no param · `?chon=` empty · whitespace only · the first
 * page still in flight (no rows yet, so "not among them" means nothing) · a code
 * the loaded pages do not contain, which is the real miss. Matching is exact
 * after trimming — codes come from the Sheet and are compared the same way
 * everywhere else in this screen.
 */
export function productInspectorState(
  selectedCode: string | null,
  items: readonly CatalogProduct[],
  options: { isLoading: boolean } = { isLoading: false },
): ProductInspectorState {
  const code = selectedCode?.trim() ?? "";
  if (code.length === 0) return { kind: "none" };

  const product = items.find((item) => item.code === code);
  if (product) return { kind: "product", product };

  // Opening a shared link showed "Không thấy mã …" for the whole first fetch,
  // then replaced it with the product: an error message for a request that had
  // not failed. While nothing has arrived, the honest answer is "đang tải".
  if (options.isLoading) return { kind: "loading", code };

  return { kind: "missing", code };
}

/**
 * Below 1024px the inspector is a modal drawer, so it must not open by itself.
 * It opens for any code the operator asked for — including one still loading and
 * one that turned out not to be on screen, because those answers are the whole
 * point of `loading` and `missing`.
 */
export function isInspectorDrawerOpen(isNarrow: boolean, state: ProductInspectorState): boolean {
  if (!isNarrow) return false;
  return state.kind !== "none";
}
