import { z } from "zod";

/**
 * Where a post's product TEXT came from — mirrors `ProductOrigin`
 * (core/domain/product) and the `product_origin` DB enum.
 *
 * `sheet` = a synced catalog row, whether the sync read a Google tab or a CSV
 * the tenant uploaded (both arrive as the same snapshot). `manual` = typed by an
 * operator on the compose screen (onboarding phase 3).
 *
 * WHY ITS OWN FILE. Two contracts need it and neither may own it: the compose
 * response (`compose.schema`) and the publish/tracking payloads
 * (`post-batch.schema`) — and those two already point at each other for
 * `PostFormat`. Putting this enum in either created a real import cycle, which
 * dependency-cruiser refused, correctly: a cycle hides which module owns what.
 * A shared vocabulary of three constants is exactly what a leaf module is for.
 */
export const PRODUCT_ORIGINS = ["sheet", "manual"] as const;
export const ProductOriginSchema = z.enum(PRODUCT_ORIGINS);
export type ProductOrigin = z.infer<typeof ProductOriginSchema>;

/** Short enough for a chip, unambiguous enough to never read as "đã đồng bộ". */
export const MANUAL_PRODUCT_BADGE = "Nhập tay";

export const PRODUCT_ORIGIN_LABELS: Record<ProductOrigin, string> = {
  sheet: "Từ dữ liệu đã đồng bộ",
  manual: MANUAL_PRODUCT_BADGE,
};
