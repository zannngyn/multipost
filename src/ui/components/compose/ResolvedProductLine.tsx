"use client";

import type { ComposeResponse } from "@/ui/schemas/compose.schema";

/**
 * The line that replaces the hint once a code resolved — template line 52–56:
 *
 *   ✓  Tên sản phẩm — mô tả ngắn · chủng loại · N ảnh · tồn 62   [Đổi sản phẩm]
 *
 * PRICE AND SIZE ARE MISSING ON PURPOSE, not forgotten. The mock shows
 * "385.000đ · size S–XL", and neither field exists anywhere in this system:
 *  - price: `sync-catalog` deliberately does not persist the four price columns
 *    (`core/domain/product.ts` — `ProductOperational.prices` is typed but never
 *    filled), so `ComposeResponse` has no field to read and no API to ask;
 *  - size: tab "Mẫu 2026" has no size column at all (`SHEET_COLUMNS`).
 * Inventing either would be a number an operator could quote to a customer.
 * What is needed to close the gap is written up in the handover, not faked here.
 *
 * Stock IS shown: this whole screen is the internal operator area, and business
 * rule 2 forbids stock in a CAPTION or a post preview, never on the tool. It
 * sits outside the caption block, exactly like the template draws it.
 */
export function ResolvedProductLine({
  id,
  composed,
  albumCount,
  onChangeProduct,
}: {
  /** The field's `aria-describedby` target: this line IS its description now. */
  id: string;
  composed: ComposeResponse;
  albumCount: number;
  onChangeProduct: () => void;
}) {
  const { content, inventory } = composed;
  const isVideo = Boolean(composed.video);

  const facts: string[] = [];
  const description = (content.description ?? "").trim();
  if (description.length > 0) facts.push(shorten(description, 64));
  const category = (content.category ?? "").trim();
  if (category.length > 0) facts.push(category);
  facts.push(isVideo ? "1 clip" : `${albumCount} ảnh`);
  facts.push(describeStock(inventory));

  return (
    <div
      id={id}
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-[var(--muted-foreground)]"
    >
      <span
        aria-hidden="true"
        className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-success/20 text-success-foreground text-[11px]"
      >
        ✓
      </span>
      <span className="text-sm font-semibold text-[var(--foreground)]">{content.name}</span>
      <span className="font-mono text-[11px] tracking-wide">{content.code}</span>

      {facts.map((fact) => (
        <span key={fact} className="flex items-center gap-2.5">
          <span aria-hidden="true">·</span>
          {fact}
        </span>
      ))}

      <span className="flex-1" />

      <button
        type="button"
        onClick={onChangeProduct}
        className="focus-visible:ring-ring cursor-pointer rounded-md text-[13px] font-medium text-[var(--primary)] outline-none focus-visible:ring-3"
      >
        Đổi sản phẩm
      </button>
    </div>
  );
}

/**
 * Stock in words. "chưa có số tồn" is a real answer, not a zero: an empty or
 * non-numeric Sheet cell arrives as null and must never read as "hết".
 */
function describeStock(inventory: ComposeResponse["inventory"]): string {
  if (!inventory) return "chưa đọc được tồn";
  if (inventory.stock === null) return "chưa có số tồn";
  return `tồn ${inventory.stock}`;
}

/** Keeps the row on one line for a long Sheet description. */
function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
