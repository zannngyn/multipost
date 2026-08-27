"use client";

import { useEffect, useRef, type CSSProperties } from "react";

import { CHANNEL_BRAND_COLOR, channelMark, type ChannelMarkId } from "./channel-marks";

import "./backdrop-motion.css";

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

/**
 * THE PLATE FILLS ITS CELL. THE LOGO INSIDE IT IS THE 40px ONE.
 *
 * Spec section 4 reads "mỗi ô chiếm đúng một ô lưới 54×54px và bám vào lưới.
 * Logo bên trong 40×40px, căn giữa ô" — cell-sized plate, 40px logo. An earlier
 * pass read the 40 as the plate and drew a 40px plate holding a 24px glyph,
 * which leaves a 7px moat of bare cloth on every side of every mark: the plate
 * never reaches a rule, so it reads as a card floating ABOVE the grid instead
 * of a cell of it. Measured off the reference shot at 6x
 * (`tmp-shots/ref-fb-zoom.png`): Buffer's plate runs 1194→1243px against rules
 * at 1194 and 1243 — 49 image px, 54 CSS px, edge to edge — with a ~38 CSS px
 * glyph inside it.
 */
const PLATE_PX = GRID_CELL_PX;
/** The logo inside the plate: `size-10` is 2.5rem, i.e. the measured 40px. A
 *  utility rather than an inline number because `ChannelMarkProps` takes a
 *  `className` and nothing else. */
const LOGO_CLASS = "size-10";

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
    /*
      `to right`, NOT the `to left` copied off Buffer. Both rules have to hang
      off the SAME corner of the cell or the two axes are a pixel out of phase
      with each other. Measured before the change (`tmp-shots/measure-grid.mjs`,
      scanning the rendered pixels rather than the DOM): horizontal rules landed
      on the cell's top edge while vertical rules landed one pixel INSIDE the
      cell's right edge. Flipping the direction hangs the vertical rule off the
      cell's left edge, which is where the CSS grid's tracks start.
    */
    "linear-gradient(to right, var(--border) 1px, transparent 1px)",
    "linear-gradient(var(--border) 1px, transparent 1px)",
  ].join(", "),
  backgroundSize: `100% 100%, 100% 100%, ${GRID_CELL_PX}px ${GRID_CELL_PX}px, ${GRID_CELL_PX}px ${GRID_CELL_PX}px`,
} as const;

/**
 * The field the entrance stagger is ranked against.
 *
 * Cell counts for a 1400x867 window at 54px — a NOMINAL field, not the live
 * one: the real column count is only known after layout, and the stagger only
 * needs an ordering ("this mark is further out than that one"), not a
 * measurement. Ranking on a fixed field also means server and client agree on
 * every delay, which a `useState` after mount would not.
 */
const NOMINAL_COLUMNS = 26;
const NOMINAL_ROWS = 16;

/** The furthest a mark travels under the cursor, before its own depth scales it
 *  down. 9px at full strength, well under 1px for the faintest marks — "a few
 *  px", which is what spec 4b allows a decoration that must not compete with
 *  the button. */
const PARALLAX_REACH_PX = 9;

/** How much of the gap to the target each frame closes. Low enough that the
 *  field trails the cursor instead of snapping to it, which is the whole
 *  impression; high enough that it settles in ~20 frames. */
const PARALLAX_FOLLOW = 0.12;

/** Below this the field has arrived: the loop writes the target exactly and
 *  parks, so a still cursor costs nothing at all. */
const PARALLAX_SETTLED_PX = 0.02;

/** How far the cursor's halo reaches. Four cells: near enough that only a
 *  handful of marks react at once, wide enough that the reaction reads as a
 *  field responding rather than one icon blinking. */
const PROXIMITY_REACH_PX = GRID_CELL_PX * 4;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The per-mark motion parameters, derived from the placement and its index.
 *
 * DETERMINISTIC, NEVER RANDOM. `Math.random()` here would render one set of
 * numbers on the server and another in the browser, and React would either warn
 * or silently keep the server's — the phases have to be a pure function of the
 * table.
 */
function markMotionStyle(placement: Placement, index: number): CSSProperties {
  const column = placement.column < 0 ? NOMINAL_COLUMNS + placement.column : placement.column;
  const distance = Math.hypot(column - NOMINAL_COLUMNS / 2, placement.row - NOMINAL_ROWS / 2);

  // Golden angle: successive marks point in directions that never bunch up, so
  // the field never looks like it is breathing in one direction.
  const angle = index * 2.399963;
  // 2–4px of travel. Any larger and the eye starts following the backdrop.
  const amplitude = 2 + (index % 5) * 0.5;
  // 8–20s, the spec's band. Seven distinct periods over 21 marks means they
  // fall out of step with each other permanently rather than re-synchronising.
  const duration = 8 + (index % 7) * 2;

  return {
    "--mark-in-rank": Math.round(distance),
    "--drift-x": `${(Math.cos(angle) * amplitude).toFixed(2)}px`,
    "--drift-y": `${(Math.sin(angle) * amplitude).toFixed(2)}px`,
    "--drift-duration": `${duration}s`,
    // Negative: the mark starts mid-cycle instead of standing still until its
    // turn comes. Coprime-ish step so no two marks share a phase.
    "--drift-phase": `-${((index * 3.7) % duration).toFixed(2)}s`,
  } as CSSProperties;
}

/**
 * The cursor parallax: ONE frame loop for the whole field.
 *
 * It writes two custom properties on the backdrop root and lets CSS inheritance
 * do the rest — 21 marks read `--parallax-x/y` and scale them by their own
 * depth. The alternative, an animation per mark, is what the previous attempt
 * did and what nobody could see move.
 *
 * IT ALSO DOES THE HOVER, because CSS cannot. The whole backdrop is
 * `pointer-events-none` — it has to be, or the decoration would eat the clicks
 * meant for "Bắt đầu" sitting above it — and an element that never receives a
 * pointer never matches `:hover`. So nearness is computed here, from the cursor
 * position the loop already has, and written per mark as `--near` (0 far, 1
 * under the cursor). Nearness beats a real hover anyway: it ramps instead of
 * snapping at the mark's edge, and it reaches the neighbours too.
 *
 * The loop only runs while the field is catching up. Pointer stops, gap closes,
 * loop parks itself; there is no permanent rAF burning a frame budget behind a
 * static picture.
 */
function useCursorParallax(hostRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const host = hostRef.current;
    // Edge cases first: no element, or a browser without matchMedia — either
    // way the picture is already correct, so do nothing rather than guess.
    if (host === null) return;
    if (typeof window.matchMedia !== "function") return;

    const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
    let frame = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let pointerX = Number.NaN;
    let pointerY = Number.NaN;

    /** Cell centres in viewport coordinates, read once rather than every frame:
     *  `getBoundingClientRect` inside a rAF loop is a forced reflow 21 times
     *  over, which is exactly the jank this design is avoiding. The drift moves
     *  a mark by ±4px around its centre, well inside the falloff. */
    let cells: { element: HTMLElement; centreX: number; centreY: number; near: number }[] = [];
    const measureCells = () => {
      cells = [...host.querySelectorAll<HTMLElement>(".onboarding-cell")].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          centreX: rect.left + rect.width / 2,
          centreY: rect.top + rect.height / 2,
          near: 0,
        };
      });
    };

    const write = () => {
      host.style.setProperty("--parallax-x", `${currentX.toFixed(2)}px`);
      host.style.setProperty("--parallax-y", `${currentY.toFixed(2)}px`);

      // No pointer yet (keyboard arrival, touch): nothing to be near to.
      if (Number.isNaN(pointerX)) return;

      for (const cell of cells) {
        const distance = Math.hypot(pointerX - cell.centreX, pointerY - cell.centreY);
        const linear = Math.max(0, 1 - distance / PROXIMITY_REACH_PX);
        // Squared: a soft halo that falls away fast, rather than a wide smear
        // that lifts a third of the field at once.
        const near = linear * linear;
        // Only touch the DOM when the value actually moved. Rounding to two
        // decimals turns a stream of noise into a handful of real writes.
        if (Math.abs(near - cell.near) < 0.005) continue;
        cell.near = near;
        cell.element.style.setProperty("--near", near.toFixed(3));
      }
    };

    const tick = () => {
      const gapX = targetX - currentX;
      const gapY = targetY - currentY;

      if (Math.abs(gapX) < PARALLAX_SETTLED_PX && Math.abs(gapY) < PARALLAX_SETTLED_PX) {
        currentX = targetX;
        currentY = targetY;
        write();
        frame = 0; // Arrived. Stop asking for frames.
        return;
      }

      currentX += gapX * PARALLAX_FOLLOW;
      currentY += gapY * PARALLAX_FOLLOW;
      write();
      frame = requestAnimationFrame(tick);
    };

    const onPointerMove = (event: PointerEvent) => {
      const { innerWidth, innerHeight } = window;
      // A zero-sized viewport would divide by zero and write NaN into the
      // stylesheet, which fails silently and leaves the field stuck.
      if (innerWidth === 0 || innerHeight === 0) return;

      pointerX = event.clientX;
      pointerY = event.clientY;
      targetX = ((event.clientX / innerWidth) * 2 - 1) * PARALLAX_REACH_PX;
      targetY = ((event.clientY / innerHeight) * 2 - 1) * PARALLAX_REACH_PX;
      if (frame === 0) frame = requestAnimationFrame(tick);
    };

    /** Cursor gone from the window: let the halo go out. `pointermove` stops
     *  firing at the edge, so without this the last-lit marks would stay lit
     *  for as long as the screen is open. */
    const onPointerOut = () => {
      pointerX = Number.NaN;
      pointerY = Number.NaN;
      for (const cell of cells) {
        if (cell.near === 0) continue;
        cell.near = 0;
        cell.element.style.removeProperty("--near");
      }
    };

    const onResize = () => {
      measureCells();
      if (frame === 0 && !Number.isNaN(pointerX)) frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      currentX = 0;
      currentY = 0;
      targetX = 0;
      targetY = 0;
      pointerX = Number.NaN;
      pointerY = Number.NaN;
      // Back to the finished picture, not to wherever the cursor left it.
      host.style.removeProperty("--parallax-x");
      host.style.removeProperty("--parallax-y");
      for (const cell of cells) {
        cell.near = 0;
        cell.element.style.removeProperty("--near");
      }
    };

    const sync = () => {
      // `reduce` means NO parallax, not a slower one (spec 4b): the listener
      // comes off and the loop never starts.
      if (reduced.matches) {
        window.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("mouseleave", onPointerOut);
        stop();
        return;
      }
      measureCells();
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("mouseleave", onPointerOut);
    };

    sync();
    reduced.addEventListener("change", sync);
    window.addEventListener("resize", onResize);

    return () => {
      reduced.removeEventListener("change", sync);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("mouseleave", onPointerOut);
      stop();
    };
  }, [hostRef]);
}

/**
 * THE MARKS MOVE, AND THE MOVEMENT IS MEASURABLE.
 *
 * The first attempt drove them with framer-motion and, measured in the running
 * app, wrote `transform: none` for 900ms — twenty-one library instances that
 * failed without saying so. It was deleted rather than left as a comment
 * claiming a motion nobody could see; spec 4b asks for the replacement.
 *
 * Four layers, and only the third of them is JavaScript:
 *   1. entrance   — CSS, staggered outwards from the middle of the field
 *   2. drift      — CSS, one slow loop per mark on its own period and phase
 *   3. parallax   — ONE rAF loop writing two custom properties (above)
 *   4. breathing  — CSS, the ruled ground alone
 *
 * Under `prefers-reduced-motion: reduce` all four are gone, not slowed: the CSS
 * lives inside a `no-preference` query and the loop above never attaches.
 */
export function GridBackdrop() {
  const hostRef = useRef<HTMLDivElement>(null);
  useCursorParallax(hostRef);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="onboarding-ground absolute inset-0" style={GROUND_STYLE} />

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
              className="onboarding-cell flex items-center justify-center"
              style={
                {
                  gridColumn: placement.column,
                  gridRow: placement.row,
                  opacity: placement.opacity,
                  /*
                    DEPTH LIVES ON THE CELL, NOT ON THE MARK INSIDE IT, and that
                    placement is load-bearing. Custom properties only inherit
                    downwards: with `--depth` on the child, the cell's own
                    proximity calc fell back to 1 and every faint mark rendered
                    at full strength — measured, not guessed. On the cell it
                    serves both readers, because the mark inherits it.

                    It IS `opacity` above, repeated as a number the stylesheet
                    can do arithmetic on: depth is the depth the picture already
                    had (spec 4b), not a second scale.
                  */
                  "--depth": placement.opacity,
                } as CSSProperties
              }
            >
              {/*
                THE MOVING PART IS A SEPARATE ELEMENT FROM THE ONE HOLDING THE
                OPACITY, and that is not a wrapper for its own sake. The
                entrance fades a mark to opacity 1; written on the cell above it
                would erase the per-mark opacity that IS the depth of this
                picture. Nested, the two multiply — a 0.07 mark fades in to
                0.07, not to 1.
              */}
              <span className="onboarding-mark flex" style={markMotionStyle(placement, index)}>
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
                  width: PLATE_PX,
                  height: PLATE_PX,
                  color: CHANNEL_BRAND_COLOR[placement.id],
                }}
              >
                  <Mark className={LOGO_CLASS} />
                </span>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
