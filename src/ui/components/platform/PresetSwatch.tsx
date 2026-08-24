"use client";

import { APPEARANCE_PRESET_ATTRIBUTE } from "@/shared/appearance-presets";

/**
 * What a preset actually looks like, drawn in that preset's own colours.
 *
 * A MINIATURE OF THE PRODUCT, not a colour chip: a preset repaints the ground,
 * the cards, the hairlines and the ink, so a row of dye-coloured bars would
 * advertise the smallest part of what changes. This shows the ground with a
 * card standing on it, a line of ink, a hairline, and the action colour — the
 * five things an operator will actually be looking at afterwards.
 *
 * WHY IT CARRIES THE ATTRIBUTE INSTEAD OF COLOURS: `presets.css` scopes every
 * block to `[data-theme-preset="…"]`, unqualified as well as on `:root` — so an
 * element wearing the attribute re-declares the whole palette for its own
 * subtree, and `bg-background` inside it paints THAT preset's ground. The
 * alternative is six hard-coded palettes in a component, which is the second
 * table `appearance-presets.ts` exists to prevent: the swatch would keep
 * showing yesterday's colours the day a preset is retuned.
 *
 * WHY PLAIN ELEMENTS AND NOT ASTRYX ONES: Astryx resolves `--color-background:
 * var(--background)` on the theme root and inherits the ANSWER, so a nested
 * override never reaches it. Tailwind's `@theme inline` (globals.css) does the
 * opposite — `bg-background` compiles to `var(--background)`, read on the
 * element itself. Only the second kind can be re-coloured in a subtree.
 *
 * Decorative: the name and description sit beside it in real text, so it adds
 * nothing for a screen reader and is hidden from it (core-accessibility §5 —
 * colour is never the only signal).
 */
export function PresetSwatch({ presetId }: { presetId: string }) {
  return (
    <div
      {...{ [APPEARANCE_PRESET_ATTRIBUTE]: presetId }}
      aria-hidden="true"
      className="bg-background border-border flex h-24 w-full flex-col justify-between overflow-hidden rounded-md border p-2"
    >
      {/* A card standing on the ground, with ink and a hairline on it. */}
      <div className="bg-card border-border flex flex-col gap-1 rounded-sm border p-1.5">
        <div className="bg-foreground h-1.5 w-2/3 rounded-full" />
        <div className="bg-muted-foreground h-1 w-1/2 rounded-full" />
      </div>

      <div className="flex items-center gap-1.5">
        {/* The action colour, with the ink that stands on it. */}
        <div className="bg-primary flex h-5 w-12 items-center justify-center rounded-sm">
          <div className="bg-primary-foreground h-1 w-6 rounded-full" />
        </div>
        {/* The "đang chọn" tint, and a sunken panel. */}
        <div className="bg-accent h-5 w-5 rounded-sm" />
        <div className="bg-secondary h-5 flex-1 rounded-sm" />
      </div>
    </div>
  );
}
