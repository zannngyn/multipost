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
 * The one action that can bring a `missing` code back into view, offered where
 * the operator is standing.
 *
 * A modal makes the page behind it inert, so "bỏ bộ lọc rồi bấm Tải thêm" — both
 * controls living out there — was an instruction that could not be carried out
 * from inside the drawer.
 */
export type InspectorRecoveryKind = "clear-filter" | "load-more";

export interface InspectorRecovery {
  kind: InspectorRecoveryKind;
  label: string;
}

/** The same thing once the screen has attached the handler that performs it. */
export type InspectorRecoveryAction = InspectorRecovery & {
  onPress: () => void;
  /**
   * The action is in flight. Required, not optional: "Tải thêm sản phẩm" fetches
   * a page WITHOUT changing anything the drawer shows — it keeps saying "Không
   * thấy mã …" until the row arrives — so a button with no busy state reads as
   * dead and gets pressed again. Whoever attaches `onPress` is the only one who
   * knows when it has landed, so they have to answer this.
   */
  isBusy: boolean;
};

const RECOVERY_LABELS: Record<InspectorRecoveryKind, string> = {
  "clear-filter": "Bỏ bộ lọc và tìm lại",
  "load-more": "Tải thêm sản phẩm",
};

/**
 * Which one, in the order of what is most likely hiding the code: the filter
 * first (the operator set it, so it is the fastest thing to undo), then the
 * pages not fetched yet. When neither applies, the whole catalogue is on screen
 * and the code is genuinely not in it — no button fixes that, and offering one
 * would be a lie.
 */
export function inspectorRecovery(options: {
  hasFilter: boolean;
  hasNextPage: boolean;
}): InspectorRecovery | null {
  if (options.hasFilter) return { kind: "clear-filter", label: RECOVERY_LABELS["clear-filter"] };
  if (options.hasNextPage) return { kind: "load-more", label: RECOVERY_LABELS["load-more"] };
  return null;
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
