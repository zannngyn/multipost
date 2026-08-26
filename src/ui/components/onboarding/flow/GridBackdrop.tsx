"use client";

import { CHANNEL_BRAND_COLOR, channelMark, type ChannelMarkId } from "./channel-marks";

/**
 * The ground the welcome screen stands on: a ruled grid with channel marks
 * scattered across it. Pure decoration — `aria-hidden`, `pointer-events-none`.
 *
 * WHY A COMPONENT AND NOT A CSS CLASS: the marks have to land ON the grid, so
 * the cell size is one number that the background formula and the mark layout
 * must agree on. Splitting it across a stylesheet and a component is how they
 * drift apart.
 */

/**
 * Measured off Buffer's own `background-size` (spec section 4). Everything else
 * here is derived from it, including where the marks sit.
 *
 * Careful reading the reference screenshots: they were captured on a wider
 * window and saved down to 1400x867, so a cell measures ~49px IN THE IMAGE
 * while the CSS number below is the real one.
 */
export const GRID_CELL_PX = 54;

/** The tile inside a cell. 40x40 in a 54px cell, per spec section 4. */
const TILE_PX = 40;

interface Placement {
  readonly id: ChannelMarkId;
  /** Grid line. NEGATIVE counts from the right edge, so the scatter stays
   *  dense at both margins whatever the window is doing. */
  readonly column: number;
  readonly row: number;
  readonly opacity: number;
}

/**
 * Where the marks sit. Three rules, all from spec section 4 and the reference
 * shot; the exact cells are deliberately not meaningful:
 *
 *   1. THIN IN THE MIDDLE. The heading and the button live there.
 *   2. THICKER AT THE MARGINS, which is what gives the screen its frame.
 *   3. LOUDNESS VARIES HARD — a handful at full strength, most of them barely
 *      above the cloth. An even wash reads as a rendering bug, which is the one
 *      failure spec section 4 names outright.
 */
const PLACEMENTS: readonly Placement[] = [
  // --- left margin -------------------------------------------------------
  { id: "youtube", column: 3, row: 4, opacity: 1 },
  { id: "instagram", column: 4, row: 10, opacity: 0.9 },
  { id: "threads", column: 2, row: 7, opacity: 0.26 },
  { id: "zalo_oa", column: 6, row: 6, opacity: 0.3 },
  { id: "shopee", column: 6, row: 3, opacity: 0.16 },
  { id: "lazada", column: 8, row: 2, opacity: 0.11 },
  { id: "facebook", column: 2, row: 13, opacity: 0.14 },
  { id: "tiktok", column: 5, row: 12, opacity: 0.07 },
  { id: "youtube", column: 7, row: 14, opacity: 0.1 },
  // --- top band, clear of the heading ------------------------------------
  { id: "tiktok", column: 9, row: 2, opacity: 0.55 },
  { id: "instagram", column: 12, row: 2, opacity: 0.09 },
  // --- bottom band, clear of the button ----------------------------------
  { id: "tiktok", column: 11, row: 12, opacity: 1 },
  { id: "shopee", column: 15, row: 13, opacity: 0.12 },
  { id: "zalo_oa", column: 13, row: 15, opacity: 0.07 },
  // --- right margin ------------------------------------------------------
  { id: "facebook", column: -4, row: 9, opacity: 1 },
  { id: "lazada", column: -3, row: 4, opacity: 0.85 },
  { id: "zalo_oa", column: -6, row: 7, opacity: 0.42 },
  { id: "threads", column: -7, row: 2, opacity: 0.22 },
  { id: "youtube", column: -8, row: 12, opacity: 0.19 },
  { id: "instagram", column: -2, row: 11, opacity: 0.13 },
  { id: "shopee", column: -5, row: 14, opacity: 0.08 },
];

/**
 * The ruled ground, copied from the real `background-image` (spec section 4)
 * with the two colours swapped for tokens.
 *
 * INLINE, not a utility class: four stacked gradients with per-layer sizes is
 * not something Tailwind expresses, and splitting it into a stylesheet would
 * separate it from `GRID_CELL_PX`.
 *
 * The fade layers use `--background` rather than the measured `#EAE8E5`. Buffer
 * fades the grid into a colour a shade off its own surface; the same trick with
 * an MYSP border token would TINT the margins instead of clearing them, because
 * `--border` here is an alpha ink. Fading to the ground is what the layer is
 * for, and it follows the light/dark switch for free.
 */
const GROUND_STYLE = {
  backgroundImage: [
    "linear-gradient(to top, var(--background) 0%, transparent 20%, transparent 80%, var(--background) 100%)",
    "linear-gradient(to right, var(--background) 0%, transparent 20%)",
    "linear-gradient(to left, var(--border) 1px, transparent 1px)",
    "linear-gradient(var(--border) 1px, transparent 1px)",
  ].join(", "),
  backgroundSize: `100% 100%, 100% 100%, ${GRID_CELL_PX}px ${GRID_CELL_PX}px, ${GRID_CELL_PX}px ${GRID_CELL_PX}px`,
} as const;

/**
 * THE MARKS DO NOT MOVE, ON PURPOSE.
 *
 * A first draft had them drifting a few pixels on staggered clocks. Measured in
 * the running app it never moved a single mark — framer-motion wrote
 * `transform: none` and left it there, while the crossfade between screens
 * animated correctly in the same page. Rather than ship a comment claiming a
 * motion nobody can see, the drift is gone: Buffer's own scatter is static, the
 * spec (section 4) describes a still field, and a decoration that does not move
 * needs no `prefers-reduced-motion` escape hatch either (spec 9.7).
 */
export function GridBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={GROUND_STYLE} />

      {/*
        A real grid of the same 54px tracks, sharing the container's top-left
        corner with the background above — which is the whole reason the marks
        land in cells rather than near them. Negative line numbers in
        `PLACEMENTS` count from the last track, so the right margin stays
        populated at any window width.

        THE MARKS STOP BELOW `md`, THE RULED GROUND DOES NOT. The scatter is
        built on "thin in the middle, thicker at the margins" (spec section 4),
        and a phone has no margins to be thick at — measured at 375px the left
        and right groups collapse into one another and land ON the greeting.
        Decoration that sits on the only sentence of the screen is worse than no
        decoration.
      */}
      <div
        className="absolute inset-0 hidden md:grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, ${GRID_CELL_PX}px)`,
          gridTemplateRows: `repeat(auto-fill, ${GRID_CELL_PX}px)`,
        }}
      >
        {PLACEMENTS.map((placement, index) => {
          const Mark = channelMark(placement.id);
          // Edge case first: a typo in the table must not blank the screen, and
          // must not pass silently either — decoration is still code.
          if (Mark === null) {
            console.warn("[onboarding] unknown channel mark in the backdrop", {
              error_code: "ONBOARDING_BACKDROP_UNKNOWN_MARK",
              mark_id: placement.id,
            });
            return null;
          }

          return (
            <span
              key={`${placement.id}-${placement.column}-${placement.row}-${index}`}
              className="flex items-center justify-center"
              style={{
                gridColumn: placement.column,
                gridRow: placement.row,
                opacity: placement.opacity,
              }}
            >
              {/*
                A near-white tile carrying the channel's own colour, which is
                how the marks read in the reference shot — not a brand-filled
                square. `rounded-sm` is the token nearest the measured 8px
                (`--radius` * 0.6 = 9.6px), and `bg-card` follows the light/dark
                switch, so the tiles do not stay white on dyed-dark cloth.

                The colour is a literal ON PURPOSE and comes from the one table
                allowed to hold literals — see the header of `channel-marks`.
              */}
              <span
                className="bg-card flex items-center justify-center rounded-sm"
                style={{
                  width: TILE_PX,
                  height: TILE_PX,
                  color: CHANNEL_BRAND_COLOR[placement.id],
                }}
              >
                <Mark className="size-6" />
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
