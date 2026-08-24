"use client";

import { APPEARANCE_PRESET_ATTRIBUTE } from "@/shared/appearance-presets";

/**
 * The colour a preset actually paints, drawn in that preset's own colours.
 *
 * WHY IT CARRIES THE ATTRIBUTE INSTEAD OF A COLOUR: `presets.css` scopes every
 * block to `[data-theme-preset="…"]`, unqualified as well as on `:root` — so an
 * element wearing the attribute re-declares the dye for its own subtree, and
 * `bg-primary` inside it paints THAT preset. The alternative is six hard-coded
 * colours in a component, which is the second table `appearance-presets.ts`
 * exists to prevent: the swatch would keep showing indigo the day a preset is
 * retuned.
 *
 * WHY PLAIN ELEMENTS AND NOT ASTRYX ONES: Astryx resolves `--color-accent:
 * var(--primary)` on the theme root and inherits the ANSWER, so a nested
 * override never reaches it. Tailwind's `@theme inline` (globals.css) does the
 * opposite — `bg-primary` compiles to `var(--primary)`, read on the element
 * itself. Only the second kind can be re-coloured in a subtree, which is what a
 * swatch has to do.
 *
 * Decorative: the name and description sit beside it in real text, so this adds
 * nothing for a screen reader and is hidden from it (core-accessibility §5 —
 * colour is never the only signal).
 */
export function PresetSwatch({ presetId }: { presetId: string }) {
  return (
    <div
      {...{ [APPEARANCE_PRESET_ATTRIBUTE]: presetId }}
      aria-hidden="true"
      className="border-border flex h-12 w-full overflow-hidden rounded-md border"
    >
      {/* The action colour — the one an operator will see most. */}
      <div className="bg-primary flex-[4]" />
      {/* The "đang chọn" tint and the ink that stands on it. */}
      <div className="bg-accent flex-[2]" />
      <div className="bg-accent-foreground flex-1" />
    </div>
  );
}
