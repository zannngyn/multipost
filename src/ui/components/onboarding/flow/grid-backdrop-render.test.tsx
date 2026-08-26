import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GRID_CELL_PX, GridBackdrop } from "./GridBackdrop";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom.
 *
 * What is worth asserting about a decoration is exactly two things — that it
 * says nothing to assistive technology, and that its geometry is the measured
 * one. Everything else here is taste, and taste belongs in the visual gate.
 */

describe("GridBackdrop", () => {
  it("is hidden from assistive technology — it is decoration", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("says nothing at all: no accessible name anywhere inside it", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    expect(html).not.toContain("aria-label");
    expect(html).not.toContain("sr-only");
  });

  it("rules the ground in 54px cells (spec section 4)", () => {
    expect(GRID_CELL_PX).toBe(54);
    const html = renderToStaticMarkup(<GridBackdrop />);
    expect(html).toContain("54px 54px");
  });

  it("draws the grid from tokens, never from a raw hex", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    expect(html).toContain("var(--border)");
    expect(html).toContain("var(--background)");
  });

  it("cannot swallow a click meant for the screen underneath", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    expect(html).toContain("pointer-events-none");
  });

  it("varies how loud the marks are, instead of one flat wash", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    const opacities = new Set([...html.matchAll(/opacity:\s*([0-9.]+)/g)].map((match) => match[1]));
    // One repeated value is the "looks like a bug" failure spec section 4 calls
    // out by name.
    expect(opacities.size).toBeGreaterThan(4);
  });

  it("keeps every mark on the grid — whole cells, no free-floating offsets", () => {
    const html = renderToStaticMarkup(<GridBackdrop />);
    // Cells are addressed by grid line, so no mark may carry a pixel offset.
    expect(html).not.toMatch(/(left|top):\s*\d+px/);
    expect(html).toMatch(/grid-column:/);
    expect(html).toMatch(/grid-row:/);
  });
});
