import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * /bulk's header band must start on the same inline edge as the other header
 * bands built the same way.
 *
 * WHY IT CAN DRIFT SILENTLY: the inset is a SUM of two numbers written in two
 * places — `LayoutHeader`'s own padding (`--spacing-4`, 16px, unless a
 * `padding` prop says otherwise) plus whatever the box inside pads itself by.
 * /bulk passes `padding={0}` so its vertical value can be stated once instead
 * of stacking to a number nobody wrote; that also zeroes the INLINE half, and
 * the first version of the fix left the title 16px to the left of every other
 * screen's. Nothing on the screen says so — you have to switch tabs to see it.
 *
 * Compared against /posts and /prompts specifically: those three build the same
 * centred `max-w-5xl` header column, so they are the ones an operator sees one
 * after another. Screens without such a column are a different construction and
 * are not this test's business.
 *
 * Structural, like the rest of the layout pins here: `vitest.config.ts` runs
 * `environment: "node"`, so there is no layout engine to measure in.
 */

/** Tailwind's spacing unit, and Astryx's `--spacing-4` default, both in px. */
const TAILWIND_STEP_PX = 4;
const LAYOUT_HEADER_DEFAULT_PX = 16;

const SCREENS = {
  "/bulk": "./BulkRunScreen.tsx",
  "/posts": "../posts/PostsHub.tsx",
  "/prompts": "../prompts/PromptTemplatesScreen.tsx",
} as const;

/**
 * Inline padding from the header's opening tag to the content inside it, in px.
 * Reads the `<LayoutHeader …>` tag and the FIRST `className` after it, which is
 * the box that owns the column on all three screens.
 */
function headerInlineInsetPx(relative: string): number {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const tagStart = source.indexOf("<LayoutHeader");
  expect(tagStart, `${relative} no longer renders a LayoutHeader`).toBeGreaterThan(-1);
  const tag = source.slice(tagStart, source.indexOf(">", tagStart) + 1);

  const paddingProp = /padding=\{(\d+)\}/.exec(tag);
  const fromHeader = paddingProp
    ? Number(paddingProp[1]) * TAILWIND_STEP_PX
    : LAYOUT_HEADER_DEFAULT_PX;

  const className = /className="([^"]*)"/.exec(source.slice(tagStart, tagStart + 1_500));
  expect(className, `${relative} header has no inner box to measure`).not.toBeNull();
  const inline = /(?:^|\s)p[xl]?-(\d+)(?:\s|$)/.exec(className![1]);
  const fromBox = inline ? Number(inline[1]) * TAILWIND_STEP_PX : 0;

  return fromHeader + fromBox;
}

describe("the /bulk header band lines up with the other header bands", () => {
  it("starts on the same inline edge as /posts and /prompts", () => {
    const bulk = headerInlineInsetPx(SCREENS["/bulk"]);

    expect(bulk).toBe(headerInlineInsetPx(SCREENS["/posts"]));
    expect(bulk).toBe(headerInlineInsetPx(SCREENS["/prompts"]));
  });

  it("is the 40px those bands have always rendered", () => {
    // Spelled out so the test still fails the day all three drift together —
    // which would be the same regression, just uniform.
    for (const relative of Object.values(SCREENS)) {
      expect(headerInlineInsetPx(relative)).toBe(40);
    }
  });

  it("keeps /bulk's vertical padding stated once, at the 32px it renders", () => {
    // The other half of the same fix: `padding={0}` + `py-8`, not 16 stacked on
    // 16. If `padding={0}` goes, the band silently grows to 48px.
    const source = readFileSync(fileURLToPath(new URL(SCREENS["/bulk"], import.meta.url)), "utf8");

    expect(source).toMatch(/<LayoutHeader[^>]*padding=\{0\}/);
    expect(source).toMatch(/className="[^"]*\bpy-8\b[^"]*"/);
  });
});
