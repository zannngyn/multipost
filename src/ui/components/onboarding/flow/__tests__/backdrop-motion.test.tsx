import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GridBackdrop } from "../GridBackdrop";
import { WelcomeScreen } from "../WelcomeScreen";

/**
 * The backdrop's motion, checked at the only two places a node-environment test
 * can reach it: the markup React emits, and the stylesheet that markup points
 * at. Whether the browser then MOVES anything is not a unit-test question — it
 * is measured in the running app, which is exactly the step the previous
 * attempt skipped.
 *
 * What these guard is the class of failure that killed that attempt: parameters
 * that never reach the CSS, and a reduced-motion escape hatch that quietly
 * stops covering a layer somebody added later.
 */

const CSS = readFileSync(fileURLToPath(new URL("../backdrop-motion.css", import.meta.url)), "utf8");
/** The same file with its comments taken out. Structural claims have to be made
 *  about the RULES; the prose above them talks about `transform` and `:hover`
 *  precisely because it is explaining why they are or are not there. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("backdrop motion stylesheet", () => {
  it("declares all four layers", () => {
    expect(CSS).toContain("@keyframes onboarding-mark-in"); // 1 entrance
    expect(CSS).toContain("@keyframes onboarding-mark-drift"); // 2 ambient drift
    expect(CSS).toContain("--parallax-x"); // 3 cursor parallax
    expect(CSS).toContain("@keyframes onboarding-ground-breathe"); // 4 breathing grid
  });

  it("puts every moving declaration behind `no-preference`, so `reduce` gets none of it", () => {
    const guarded = RULES.slice(RULES.indexOf("@media (prefers-reduced-motion: no-preference)"));
    const firstKeyframes = guarded.indexOf("@keyframes");
    const inQuery = guarded.slice(0, firstKeyframes);

    // Nothing that moves may live outside the query. Keyframes themselves may:
    // an unreferenced @keyframes animates nothing.
    const outsideQuery = RULES.slice(0, RULES.indexOf("@media (prefers-reduced-motion"));
    expect(outsideQuery).not.toContain("animation:");
    expect(outsideQuery).not.toContain("transform:");

    for (const declaration of ["animation:", "transform: translate3d"]) {
      expect(inQuery).toContain(declaration);
    }
  });

  it("times the entrances on Astryx duration tokens, not on invented numbers", () => {
    expect(CSS).toContain("var(--duration-medium-min) var(--ease-standard)");
    // The stagger step has no token of its own, so it is DERIVED from one.
    expect(CSS).toContain("calc(var(--duration-fast) / 3)");
  });

  it("animates nothing but transform, translate, scale and opacity", () => {
    // Real properties only: `--*` lines are parameters, not things that paint.
    const declared = [...RULES.matchAll(/^\s{4}(?!--)([a-z-]+):/gm)].map((match) => match[1]);
    const offenders = declared.filter(
      (property) => !["opacity", "scale", "translate", "transform", "animation"].includes(property),
    );
    expect(offenders).toEqual([]);
  });

  it("reacts to the cursor's nearness, because :hover can never fire here", () => {
    // The backdrop is `pointer-events-none` so it cannot steal a click from
    // "Bắt đầu"; that also means it never matches :hover. If this file ever
    // grows a :hover rule, it is a rule that does nothing.
    expect(RULES).not.toContain(":hover");
    expect(CSS).toContain("var(--near, 0)");
    // At rest the boost resolves to the depth the markup already stated.
    expect(CSS).toContain("calc(var(--depth, 1) + (1 - var(--depth, 1)) * var(--near, 0)");
  });
});

describe("backdrop motion markup", () => {
  it("hands every mark its own phase, period and depth", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);

    expect(html).toContain("onboarding-mark");
    // Depth is the opacity the picture already had, not a second scale — and it
    // sits on the CELL, because custom properties only inherit downwards and the
    // cell's own proximity calc has to read it.
    expect(html).toMatch(/class="onboarding-cell[^"]*"[^>]*--depth:0\.07/);
    // Distinct periods and phases: one shared clock is the "everything breathes
    // together" failure.
    const periods = new Set([...html.matchAll(/--drift-duration:(\d+)s/g)].map((m) => m[1]));
    const phases = new Set([...html.matchAll(/--drift-phase:(-[\d.]+)s/g)].map((m) => m[1]));
    expect(periods.size).toBeGreaterThan(4);
    expect(phases.size).toBeGreaterThan(15);
  });

  it("keeps the marks' own opacity out of the entrance animation", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    // The faint marks must still be faint once the entrance has faded them to
    // its own opacity:1 — which only holds if the two sit on separate elements.
    expect(html).toMatch(/opacity:0\.07[^>]*>\s*<span class="onboarding-mark/);
  });

  it("staggers outwards: the middle of the field ranks below the margins", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    const ranks = [...html.matchAll(/--mark-in-rank:(\d+)/g)].map((match) => Number(match[1]));
    expect(ranks).toHaveLength(21);
    // The spread is what makes it a stagger; the absolute ranks depend on where
    // the placements happen to sit, and the middle of the field is deliberately
    // empty, so pinning a minimum of zero would pin the wrong thing.
    expect(Math.max(...ranks) - Math.min(...ranks)).toBeGreaterThanOrEqual(6);
  });

  it("brings the greeting and its button in on the flow's shared entrance timeline", () => {
    // They used to have a private rule in this stylesheet. Since 26/08/2026
    // they ride `onboarding-motion.css` like the four questions do — the
    // heading on row 4 of the spec's table, the button in the slot where the
    // first card would be. What had to survive the move is the FINDING, not the
    // numbers: the copy arrives after the field has started landing but does
    // NOT wait for the outermost marks at ~725ms, which would leave the only
    // way forward invisible for most of a second. 260ms + 525ms = 785ms.
    const html = renderToStaticMarkup(<WelcomeScreen name="Vân" onStart={() => {}} />);
    expect(html).toContain("onboarding-enter");
    expect(html).not.toContain("onboarding-late-in");
    expect(html).toContain("--enter-delay:100ms");
    expect(html).toContain("--enter-delay:260ms");
  });
});
