import type { CSSProperties } from "react";

/**
 * WHERE EACH PART OF A SCREEN ARRIVES — the one copy of the entrance timeline
 * (animation spec section 4). The stylesheet next door owns the SHAPE of the
 * movement; this file owns the clock, because the clock is read from six
 * different components and a delay copied into six files is a delay that ends
 * up meaning six different things.
 *
 * The values are `animation-delay`s, written in ms on purpose: the theme's
 * scale is a scale of DURATIONS, and a delay is a position on a timeline rather
 * than a length of one. Where a delay is a multiple of the card rhythm it is
 * written as that multiple of `--stagger`, which IS derived from a token — see
 * the table in `onboarding-motion.css` for the arithmetic and for why the tail
 * of the spec's own table is compressed to hold the 1.2s ceiling.
 */

/** Row 1: the back arrow and the wordmark. The head of the timeline. */
export const ENTER_DELAY_BRAND = "0ms";
/** Row 2: the position dots. */
export const ENTER_DELAY_DOTS = "80ms";
/** Row 3: the light/dark control. */
export const ENTER_DELAY_THEME = "120ms";
/** Row 4: the question. Overlaps the top bar — it is the thing being read. */
export const ENTER_DELAY_HEADING = "100ms";
/** Row 5: the first card. The rest add `--enter-index` on top of it. */
export const ENTER_DELAY_CARDS = "260ms";
/** Row 6: one stagger step past the last of six cards. */
export const ENTER_DELAY_CTA = "calc(260ms + 6 * var(--stagger))";
/** Row 7: one step past the CTA, on the shorter band (it only fades). */
export const ENTER_DELAY_SKIP = "calc(260ms + 7 * var(--stagger))";

/**
 * WHERE THE STAGGER STOPS.
 *
 * Six is the largest card count the spec choreographs, and it is also the
 * largest this timeline can carry: card seven would start at 697.5ms and finish
 * at 1222.5ms, past the 1.2s that section 10 makes an acceptance criterion.
 * Step 4 draws eight channel tiles, so the last three arrive together with the
 * sixth — which is the limit core-motion asks for anyway ("stagger 5-8 mục
 * đầu, phần còn lại xuất hiện ngay").
 */
const LAST_STAGGERED_INDEX = 5;

/** The delay a whole group of arriving elements measures from. */
export function enterDelay(delay: string): CSSProperties {
  return { "--enter-delay": delay } as CSSProperties;
}

/** One element's place in a staggered series, counted from 0. */
export function enterIndex(index: number): CSSProperties {
  // --- Edge case first: a negative or non-finite index would resolve to an
  // invalid `calc`, which drops the delay and lands the whole series at once.
  const safe = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return { "--enter-index": Math.min(safe, LAST_STAGGERED_INDEX) } as CSSProperties;
}
