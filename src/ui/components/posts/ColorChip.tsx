import { cn } from "@/shared/utils";
import { colorSwatch } from "@/ui/components/compose/color-swatch";

/**
 * The colour of a post, in a table cell: the dye itself, then its name.
 *
 * Same swatch source as the compose screen's `ColorChips` (`colorSwatch`), so a
 * "XANH RÊU" the operator picked while composing looks the same shade when they
 * come back to check whether it went out. Reusing the map rather than a second
 * one is the point — two lists of hexes would drift apart within a sprint
 * (core-component-reuse).
 *
 * The NAME is always rendered. The dot is `aria-hidden` decoration on top of it,
 * and when `colorSwatch` does not know the word there is no dot at all: an
 * invented shade next to "TRẮNG" would be a lie about the clothes, and a grey
 * placeholder dot in a colour column reads as "grey" (core-accessibility §5 —
 * colour is never the only channel).
 *
 * `whitespace-nowrap`: this cell is scanned down a column, so "XANH RÊU" must
 * not break into two lines (wave 1.5 Mono Ledger rule).
 */
export function ColorChip({
  color,
  emptyLabel,
  className,
}: {
  color: string;
  /** What an EMPTY colour means on this screen — the caller owns that sentence. */
  emptyLabel: string;
  className?: string;
}) {
  const name = color.trim();

  if (name.length === 0) {
    return <span className={cn("text-muted-foreground whitespace-nowrap", className)}>{emptyLabel}</span>;
  }

  const swatch = colorSwatch(name);

  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      {swatch ? (
        <span
          aria-hidden="true"
          style={{ background: swatch }}
          className="size-3 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
        />
      ) : null}
      {name}
    </span>
  );
}
