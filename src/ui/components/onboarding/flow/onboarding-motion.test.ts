import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ENTER_DELAY_BRAND,
  ENTER_DELAY_CARDS,
  ENTER_DELAY_CTA,
  ENTER_DELAY_DOTS,
  ENTER_DELAY_HEADING,
  ENTER_DELAY_SKIP,
  ENTER_DELAY_THEME,
  enterIndex,
} from "./onboarding-motion";

/**
 * The flow's motion, checked at the two places a node-environment test can
 * reach it: the stylesheet, and the arithmetic of the timeline that drives it.
 * Whether the browser then MOVES anything is not a unit-test question.
 *
 * What these guard is the class of failure that cannot be seen by reading:
 * a duration typed as a number instead of read off the theme, a layer that
 * quietly escapes the reduced-motion query, and — the one the spec makes an
 * acceptance criterion — an entrance whose tail creeps past 1.2 seconds.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("./onboarding-motion.css", import.meta.url)),
  "utf8",
);
/** The same file with its comments taken out. Structural claims have to be made
 *  about the RULES; the prose above them names the very properties it explains
 *  are absent. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The frame's own source, read as TEXT rather than imported: importing it
 *  would pull framer-motion, the backdrop and the theme toggle into a test that
 *  only needs two numbers. Same idiom as the stylesheet above. */
const FRAME = readFileSync(
  fileURLToPath(new URL("./OnboardingFrame.tsx", import.meta.url)),
  "utf8",
);

const THEME = readFileSync(
  fileURLToPath(new URL("../../../theme/mysp.css", import.meta.url)),
  "utf8",
);

/** A duration token's value in ms, read off the generated theme rather than
 *  written here — the whole point of the mapping is that these are not typed. */
function token(name: string): number {
  const found = new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)ms`).exec(THEME);
  if (found === null) throw new Error(`the theme declares no --${name}`);
  return Number(found[1]);
}

const STAGGER_MS = token("duration-fast") / 2;
const RISE_MS = token("duration-slow-min");
const FADE_MS = token("duration-medium-max");

/** Resolves the two shapes the entrance delays are written in. */
function delayMs(delay: string): number {
  const plain = /^(\d+(?:\.\d+)?)ms$/.exec(delay);
  if (plain !== null) return Number(plain[1]);

  const staggered =
    /^calc\((\d+(?:\.\d+)?)ms \+ (\d+) \* var\(--stagger\)\)$/.exec(delay);
  if (staggered !== null)
    return Number(staggered[1]) + Number(staggered[2]) * STAGGER_MS;

  throw new Error(`unreadable entrance delay: ${delay}`);
}

describe("onboarding motion stylesheet", () => {
  it("puts every moving declaration behind `no-preference`, so `reduce` gets none of it", () => {
    const queryAt = RULES.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    expect(queryAt).toBeGreaterThan(-1);

    const outsideQuery = RULES.slice(0, queryAt);
    const insideQuery = RULES.slice(queryAt, RULES.indexOf("@keyframes"));

    // Outside the query there is nothing but the token aliases: values, which
    // move nothing on their own.
    expect(outsideQuery).not.toContain("animation");
    expect(outsideQuery).not.toContain("transition");
    // Keyframes may live outside a query — an unreferenced one animates nothing.
    for (const declaration of [
      "animation:",
      "animation-name:",
      "transition:",
    ]) {
      expect(insideQuery).toContain(declaration);
    }
  });

  it("animates nothing but transform, translate, scale, rotate and opacity", () => {
    // Real properties only: `--*` lines are parameters, not things that paint.
    const declared = [...RULES.matchAll(/^\s{4}(?!--)([a-z-]+):/gm)].map(
      (match) => match[1],
    );
    const offenders = declared.filter(
      (property) =>
        ![
          "opacity",
          "scale",
          "translate",
          "rotate",
          "transform",
          "box-shadow",
          "animation",
          "animation-name",
          "animation-delay",
          "animation-duration",
          "animation-fill-mode",
          "animation-timing-function",
          "transition",
          "transition-property",
          "transition-duration",
          "transition-timing-function",
        ].includes(property),
    );
    expect(offenders).toEqual([]);

    // The properties a transition is allowed to name, in one place. `width`,
    // `height`, `top`, `left` and `margin` are what spec section 2.4 forbids,
    // and they are also what makes a card re-lay-out on every frame.
    const transitioned = [...RULES.matchAll(/transition-property:([^;]+);/g)]
      .flatMap((match) => match[1].split(","))
      .map((property) => property.trim());
    expect(transitioned).not.toContain("width");
    expect(transitioned).not.toContain("height");
    expect(transitioned).not.toContain("margin");
  });

  it("fills the entrance BACKWARDS, so a finished animation stops outranking the cascade", () => {
    /**
     * The trap, measured in the browser rather than reasoned about.
     *
     * A filled animation's value comes from the ANIMATION origin, which sits
     * above every author declaration — utilities, inline styles, `!important`.
     * With `both` (or `forwards`) these rules keep writing the keyframe's final
     * `opacity: 1` for the life of the page, so the dimmed card's `opacity-45`
     * never took effect: the class was in the markup and
     * `getComputedStyle(card).opacity` still answered "1". Cancelling the
     * card's animations by hand flipped it to "0.45", which is what located it.
     *
     * `backwards` fills the DELAY and nothing after it, handing the property
     * back to the cascade once the animation is done. THAT IS THE SMALLER HALF:
     * during the animation the origin wins regardless of fill-mode, so the real
     * fix is structural — entrance on a wrapper, state on the child — and it is
     * guarded in `option-card-render.test.tsx` ("the entrance never shares an
     * element with the state it would outrank"). This test only pins the tail. That is only safe because
     * the three classes declare no resting `opacity`/`transform` of their own —
     * asserted below, because the day one gains a base `opacity: 0` the element
     * disappears the moment its entrance finishes.
     */
    const shared =
      /\.onboarding-enter,\s*\.onboarding-enter-drop,\s*\.onboarding-enter-fade\s*\{([^}]*)\}/.exec(
        RULES,
      );
    expect(shared).not.toBeNull();
    expect(shared?.[1]).toContain("animation-fill-mode: backwards");
    expect(shared?.[1]).not.toContain("both");
    expect(shared?.[1]).not.toContain("forwards");

    // The resting state must BE the keyframes' destination, never a from-state.
    for (const rule of RULES.split("}")) {
      if (!/\.onboarding-enter[a-z-]*\s*\{/.test(rule + "}")) continue;
      expect(rule).not.toMatch(/^\s*opacity:/m);
      expect(rule).not.toMatch(/^\s*transform:/m);
    }
  });

  it("never pins a property after the animation — no `both`, anywhere in this file", () => {
    /**
     * One line, self-documenting, and it is the only thing standing behind the
     * three fill-modes that were changed by inspection rather than by a failing
     * test (`check-in`, `cta-arrow`, `hint-in`). Reverting any of them to `both`
     * left the suite green, which is a gap worth closing cheaply.
     *
     * `both`/`forwards` keep the keyframe's final value in the ANIMATION origin
     * for the life of the element, above every author declaration. Every
     * keyframe in this file ends at the resting state anyway, so the fill buys
     * nothing and costs the ability to style the element afterwards.
     *
     * SCOPED TO THIS FILE ON PURPOSE. `backdrop-motion.css` uses `both`
     * legitimately: there the opacity lives on the parent `.onboarding-cell`
     * while the keyframe runs on the child `.onboarding-mark`, so they are two
     * different elements and cannot contend.
     */
    const fills = [...RULES.matchAll(/animation(?:-fill-mode)?:([^;]*);/g)].map(
      (match) => match[1].trim(),
    );
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.filter((value) => /\b(both|forwards)\b/.test(value))).toEqual(
      [],
    );
  });

  it("times everything on the theme's duration tokens, never on typed numbers", () => {
    const insideQuery = RULES.slice(
      RULES.indexOf("@media"),
      RULES.indexOf("@keyframes"),
    );
    // A bare `250ms` in a rule is a duration that has escaped the theme. Delays
    // are the exception and they are all written on the elements, not here.
    expect(insideQuery).not.toMatch(/:\s*\d+m?s\b/);
    expect(CSS).toContain("--dur-micro: var(--duration-fast-max)");
    expect(CSS).toContain("--dur-state: var(--duration-medium)");
    expect(CSS).toContain("--dur-enter: var(--duration-slow-min)");
    expect(CSS).toContain("--dur-screen: var(--duration-medium-max)");
    // The stagger has no token of its own, so it is DERIVED from one.
    expect(CSS).toContain("calc(var(--duration-fast) / 2)");
  });

  it("declares the aliases where THIS project's duration scale is, not on :root", () => {
    /**
     * The trap this guards, spelled out because it fails silently.
     *
     * A custom property is substituted on the element it is declared on.
     * `mysp.css` puts `--duration-*` inside `@scope ([data-astryx-theme="mysp"])`
     * — on the `<Theme>` wrapper — while `@astryxdesign/core` also declares them
     * on `:root`, at the library's slower values. An alias on `:root` would
     * therefore resolve against the LIBRARY: `--dur-enter` 730ms instead of
     * 525ms, the stagger 87.5ms instead of 62.5ms (over the ceiling), the last
     * card landing at 1427ms instead of 1097ms. Nothing would throw.
     */
    expect(CSS).toContain("[data-astryx-theme] {");
    expect(RULES).not.toMatch(/:root\s*\{/);
    // And the two scales really are different, which is the whole reason.
    expect(token("duration-slow-min")).not.toBe(730);
  });

  it("keeps the one curve outside the scale to selection feedback", () => {
    // Astryx ships a single easing token and it does not overshoot. The spring
    // is written out here because the spec's check and pop are DEFINED by their
    // overshoot — but an entrance that overshoots is spec section 9's own
    // anti-pattern, so every entrance rule has to read `--ease-standard`.
    expect(CSS).toContain("--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)");
    for (const rule of RULES.split("}")) {
      if (!rule.includes("animation-name: onboarding-enter")) continue;
      expect(rule).not.toContain("--ease-spring");
    }
  });
});

describe("onboarding entrance timeline", () => {
  it("keeps the spec's reading order", () => {
    // Spec section 4: header, then heading, then the choices, then the way
    // forward, then the way past. The heading overlaps the header on purpose —
    // it is the thing being read, and it must not wait for decoration.
    expect(delayMs(ENTER_DELAY_BRAND)).toBeLessThan(delayMs(ENTER_DELAY_DOTS));
    expect(delayMs(ENTER_DELAY_DOTS)).toBeLessThan(delayMs(ENTER_DELAY_THEME));
    expect(delayMs(ENTER_DELAY_HEADING)).toBeLessThan(
      delayMs(ENTER_DELAY_CARDS),
    );
    expect(delayMs(ENTER_DELAY_CARDS)).toBeLessThan(delayMs(ENTER_DELAY_CTA));
    expect(delayMs(ENTER_DELAY_CTA)).toBeLessThan(delayMs(ENTER_DELAY_SKIP));
  });

  it("finishes inside the 1.2s the spec makes an acceptance criterion", () => {
    // Spec section 2 caps the whole entrance at 1.2s while section 4's own
    // table runs to 1.4s; section 10's first acceptance line is the 1.2s, so
    // the order is the spec's and the tail is compressed. This is that
    // compression, made checkable — the arithmetic is in the stylesheet.
    const lastCard = delayMs(ENTER_DELAY_CARDS) + 5 * STAGGER_MS + RISE_MS;
    const cta = delayMs(ENTER_DELAY_CTA) + RISE_MS;
    const skip = delayMs(ENTER_DELAY_SKIP) + FADE_MS;

    expect(Math.max(lastCard, cta, skip)).toBeLessThanOrEqual(1200);
  });

  it("staggers below the 80ms that reads as queueing", () => {
    // Spec section 9's anti-pattern list. 62.5ms, derived from `--duration-fast`.
    expect(STAGGER_MS).toBeLessThanOrEqual(80);
    expect(STAGGER_MS).toBeGreaterThan(30);
  });

  it("keeps the screen change's two hardcoded durations on the theme's scale", () => {
    /**
     * `OnboardingFrame` is the one place a duration cannot be a `var()`:
     * framer-motion takes numbers. So the tokens are resolved by hand there —
     * and a resolved number is exactly the kind of value that goes stale in
     * silence when the generated theme moves. These two drive the horizontal
     * slide the PM chose, and nothing else was watching them.
     */
    const enter = /const ENTER_DURATION = ([\d.]+);/.exec(FRAME);
    const exit = /const EXIT_DURATION = ([\d.]+);/.exec(FRAME);
    expect(enter).not.toBeNull();
    expect(exit).not.toBeNull();

    // Seconds in the file, milliseconds in the theme.
    expect(Number(enter?.[1]) * 1000).toBe(token("duration-medium-max"));
    expect(Number(exit?.[1]) * 1000).toBe(token("duration-medium"));

    // Spec section 6's rule, which is the reason the two differ at all: the old
    // screen must clear out faster than the new one arrives, or the flow reads
    // as going backwards.
    expect(Number(exit?.[1])).toBeLessThan(Number(enter?.[1]));
  });

  it("keeps the backdrop on its OWN clock, not the screen change's", () => {
    /**
     * The regression this pins. The backdrop behind the greeting crossfades; it
     * does not travel, and section 6 is not about it. When the screens became a
     * slide, `ENTER_DURATION`/`EXIT_DURATION` were re-valued from 0.225/0.125 to
     * 0.4/0.3 — and the backdrop was still reading them, so it silently slowed
     * ~78% in and 140% out. `REDUCED_DURATION` was dropped in the same edit,
     * leaving reduced motion on `0` instead of 0.095. Neither was decided.
     *
     * Separate names now, and the values pinned to the tokens they came from.
     */
    const enter = /const BACKDROP_ENTER_DURATION = ([\d.]+);/.exec(FRAME);
    const exit = /const BACKDROP_EXIT_DURATION = ([\d.]+);/.exec(FRAME);
    const reduced = /const BACKDROP_REDUCED_DURATION = ([\d.]+);/.exec(FRAME);

    expect(Number(enter?.[1]) * 1000).toBe(token("duration-medium-min"));
    expect(Number(exit?.[1]) * 1000).toBe(token("duration-fast"));
    expect(Number(reduced?.[1]) * 1000).toBe(token("duration-fast-min"));

    // And they are genuinely not the screen's, which is the whole point.
    const screenEnter = /const ENTER_DURATION = ([\d.]+);/.exec(FRAME);
    expect(Number(enter?.[1])).not.toBe(Number(screenEnter?.[1]));

    // Reduced motion keeps a real fade for the backdrop rather than snapping to
    // zero: "giảm chuyển động" is not "no feedback" (core-motion).
    expect(Number(reduced?.[1])).toBeGreaterThan(0);
  });

  it("caps the stagger, so a step with more cards cannot run the tail long", () => {
    // Step 4 draws eight channel tiles. A seventh staggered tile would start at
    // 697.5ms and land at 1222.5ms, past the ceiling above — so the tail of a
    // long series arrives together, which is what core-motion asks for anyway.
    expect(enterIndex(5)).toEqual({ "--enter-index": 5 });
    expect(enterIndex(7)).toEqual({ "--enter-index": 5 });
    // Edge cases: a bad index must not resolve to an invalid `calc`, which
    // would drop the delay and land the whole series at once.
    expect(enterIndex(-1)).toEqual({ "--enter-index": 0 });
    expect(enterIndex(Number.NaN)).toEqual({ "--enter-index": 0 });
  });
});
