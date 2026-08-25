import { LOW_STOCK_LABEL, blockedReasonLabel } from "@/ui/schemas/catalog.schema";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * "Can I post this code?" as one fact, derived in ONE place.
 *
 * Lives in a plain module rather than next to the table it started in: the
 * legend, the table and the inspector all ask the same question, and a `.tsx`
 * that pulls the whole design system in is the wrong dependency for a rule that
 * is three comparisons.
 *
 * `composable` is decided by the SERVER. Nothing here re-derives it from stock +
 * media counts: the day the rule changes, a client-side guess would offer a
 * "Soạn bài" button that dies on the next screen with the real reason.
 */
export type ProductStatusVariant = "success" | "warning" | "error";

export interface ProductStatusView {
  variant: ProductStatusVariant;
  /** The word next to the dot — colour is never alone (Named Status Rule). */
  label: string;
}

/** The colour band only. The legend groups by this; the row also needs a label. */
export function productStatusVariant(product: CatalogProduct): ProductStatusVariant {
  if (!product.composable) return "error";
  if (product.inventory.status === "low_stock") return "warning";
  return "success";
}

/**
 * The band plus the name for THIS row. A blocked row is named by its reason
 * ("Hết hàng", "Thiếu ảnh") instead of a flat "Bị chặn": two different problems
 * must not read the same (business rule 5).
 */
export function productStatus(product: CatalogProduct): ProductStatusView {
  const variant = productStatusVariant(product);

  if (variant === "error") {
    return {
      variant,
      label: product.blockedReason
        ? blockedReasonLabel(product.blockedReason.code)
        : "Không đăng được",
    };
  }
  if (variant === "warning") return { variant, label: LOW_STOCK_LABEL };
  return { variant, label: "Đăng được" };
}
