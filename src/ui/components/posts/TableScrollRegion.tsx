import type { ReactNode } from "react";

/**
 * The scrollable frame both /posts tables live in.
 *
 * Two things it owns, in one place so the two tables cannot drift apart:
 *
 * 1. THE REGION. `overflow-x-auto` + `tabIndex={0}` + `role="region"` — a box
 *    that scrolls must be reachable by keyboard, and a focusable box must have
 *    an accessible name (core-accessibility, WCAG 2.1.1 / 4.1.2).
 *
 * 2. THE SCROLL CUE (spec §3.2, mobile). Below ~900px the eight columns do not
 *    fit and the table scrolls sideways. On a phone there is no visible
 *    scrollbar to say so, and a row that ends flush at the edge looks finished
 *    — the operator never learns that "Thao tác" exists. `scroll-cue-x`
 *    (globals.css) draws a soft edge on whichever side still has table behind
 *    it, with background layers alone: no scroll listener, no JS, nothing to
 *    keep in sync, and it costs nothing on desktop where the table already
 *    fits (the cue hides itself at both ends).
 *
 * Stacking the row instead was the other option in the brief; see the wave-2
 * report for why the cue won — in one word, the column headers. A stacked card
 * has to repeat "Trạng thái:" on every field, and this table's whole job is
 * being read DOWN a column.
 */
export function TableScrollRegion({
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <div
      // `bg-card` is not decoration here: the cue's cover layers are painted in
      // the surface colour, so the region has to DECLARE its surface instead of
      // inheriting whatever happens to be behind it — a mismatch would leave a
      // coloured stripe down each edge.
      className="scroll-cue-x bg-card overflow-x-auto rounded-xl border"
      tabIndex={0}
      role="region"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    >
      {children}
    </div>
  );
}
