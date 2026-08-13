"use client";

import { cn } from "@/shared/utils";
import {
  formatCount,
  type CatalogProductTotals,
  type ProductFilterStatus,
} from "@/ui/schemas/catalog.schema";

/**
 * The three numbers an operator opens this screen for: how many products, how
 * many can be posted, how many are blocked. Each one is also the filter for
 * itself (core-data-list-query: a facet with a count must be clickable, and a
 * count of 0 must not lead to an empty screen).
 *
 * Radio-group semantics, not three toggle buttons: exactly one of the three is
 * active at any time, and that is what `aria-pressed` alone cannot say.
 */
export function ProductTotalsBar({
  totals,
  active,
  onSelect,
  disabled,
}: {
  totals: CatalogProductTotals;
  /** `null` = "Tổng" (no status filter). */
  active: ProductFilterStatus | null;
  onSelect: (status: ProductFilterStatus | null) => void;
  disabled?: boolean;
}) {
  const cells: {
    key: string;
    status: ProductFilterStatus | null;
    label: string;
    value: number;
    hint: string;
  }[] = [
    { key: "all", status: null, label: "Tổng", value: totals.total, hint: "Mọi mã đã đồng bộ" },
    {
      key: "ok",
      status: "ok",
      label: "Đăng được",
      value: totals.ok,
      hint: "Còn hàng và có đủ ảnh",
    },
    {
      key: "blocked",
      status: "blocked",
      label: "Bị chặn",
      value: totals.blocked,
      hint: "Hết hàng, thiếu ảnh hoặc xung đột Sheet",
    },
  ];

  return (
    <div role="group" aria-label="Lọc nhanh theo trạng thái" className="grid gap-2 sm:grid-cols-3">
      {cells.map((cell) => {
        const isActive = cell.status === active;
        // A count of 0 stays clickable only when it is the active filter, so
        // nobody lands on an empty table they cannot explain.
        const isEmpty = cell.value === 0 && !isActive;

        return (
          <button
            key={cell.key}
            type="button"
            onClick={() => onSelect(cell.status)}
            disabled={disabled || isEmpty}
            aria-pressed={isActive}
            className={cn(
              "focus-visible:ring-ring/50 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-3",
              isActive ? "border-primary bg-muted" : "bg-card hover:bg-muted/50",
              isEmpty ? "cursor-not-allowed opacity-60" : "",
            )}
          >
            <span className="text-muted-foreground block text-xs">{cell.label}</span>
            <span className="block text-2xl font-semibold tabular-nums">
              {formatCount(cell.value)}
            </span>
            <span className="text-muted-foreground block text-xs">{cell.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
