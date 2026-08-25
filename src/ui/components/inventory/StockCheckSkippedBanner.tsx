"use client";

import { Banner } from "@astryxdesign/core";

import {
  STOCK_CHECK_SKIPPED_TITLE,
  stockCheckSkippedDescription,
} from "@/ui/components/inventory/stock-check";

/**
 * The red block that has to be on screen wherever a stock status is shown while
 * the tenant runs `stockPolicy.mode = "disabled"`.
 *
 * It is `error`, not `warning`, on purpose: CLAUDE.md business rule 3 (kiểm tồn
 * hai lần) is SUSPENDED for this tenant, and an operator scanning the screen has
 * to see that before they read any number. Not dismissable for the same reason —
 * the condition does not go away by being acknowledged.
 *
 * Deliberately NOT rendered by `stockLabel`'s callers automatically: the banner
 * belongs at the top of a screen (one per screen), while the label belongs in
 * every row. One component, three screens — catalog list, catalog inspector,
 * compose/duyệt caption.
 *
 * It never appears inside a caption block: this is internal operator
 * information (business rule 2), and every call site places it outside.
 */
export function StockCheckSkippedBanner({
  reason,
  container = "card",
}: {
  /** The reason the tenant declared. Null renders the warning without a quote. */
  reason: string | null;
  /** `section` for a full-bleed screen header, `card` inside page content. */
  container?: "card" | "section";
}) {
  return (
    <Banner
      status="error"
      container={container}
      title={STOCK_CHECK_SKIPPED_TITLE}
      description={stockCheckSkippedDescription(reason)}
    />
  );
}
