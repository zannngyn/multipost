import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * /bulk's header band must start on the same inline edge as the other header
 * bands built the same way.
 *
 * WHY IT CAN DRIFT SILENTLY: two paddings are in play — `LayoutHeader`'s own
 * (`--spacing-4`, 16px, unless a `padding` prop says otherwise) and whatever
 * the box inside pads itself by — and it is tempting to add them. You must
 * not. All three boxes are `mx-auto max-w-5xl`: below the column width they are
 * CENTRED in whatever room the header leaves, so the header's inline padding is
 * eaten by the centring and never moves the title. Only the box's own inline
 * padding reaches it.
 *
 * An earlier version of this test added the two, "proved" 40px, and let /bulk
 * ship `px-10`: measured in the browser at 1440 its h1 stood at x=376 while
 * /posts and /prompts stood at x=360, and /bulk's own content column below it
 * (`px-6`) started at 360 too. Nothing on the screen says so — you have to
 * switch tabs, or measure, to see it.
 *
 * Compared against /posts and /prompts specifically: those three build the same
 * centred `max-w-5xl` header column, so they are the ones an operator sees one
 * after another. Screens without such a column are a different construction and
 * are not this test's business.
 *
 * Structural, like the rest of the layout pins here: `vitest.config.ts` runs
 * `environment: "node"`, so there is no layout engine to measure in.
 */

/** Tailwind's spacing unit, in px. */
const TAILWIND_STEP_PX = 4;

const SCREENS = {
  "/bulk": "./BulkRunScreen.tsx",
  "/posts": "../posts/PostsHub.tsx",
  "/prompts": "../prompts/PromptTemplatesScreen.tsx",
} as const;

/**
 * The inline padding of the CENTRED COLUMN inside the header band, in px —
 * the only padding that reaches the title (see the note at the top of the
 * file). Reads the FIRST `className` after `<LayoutHeader …>`, which is that
 * box on all three screens, and checks it really is the centred column.
 */
function headerColumnInsetPx(relative: string): number {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const tagStart = source.indexOf("<LayoutHeader");
  expect(tagStart, `${relative} no longer renders a LayoutHeader`).toBeGreaterThan(-1);

  const className = /className="([^"]*)"/.exec(source.slice(tagStart, tagStart + 1_500));
  expect(className, `${relative} header has no inner box to measure`).not.toBeNull();

  const box = className![1];
  // If the box stops being the centred column, the arithmetic above changes
  // and this test is measuring the wrong thing — say so rather than pass.
  expect(box, `${relative} header box is no longer the centred max-w-5xl column`).toMatch(
    /\bmx-auto\b[\s\S]*\bmax-w-5xl\b|\bmax-w-5xl\b[\s\S]*\bmx-auto\b/,
  );

  const inline = /(?:^|\s)p[xl]?-(\d+)(?:\s|$)/.exec(box);
  return inline ? Number(inline[1]) * TAILWIND_STEP_PX : 0;
}

describe("the /bulk header band lines up with the other header bands", () => {
  it("starts on the same inline edge as /posts and /prompts", () => {
    const bulk = headerColumnInsetPx(SCREENS["/bulk"]);

    expect(bulk).toBe(headerColumnInsetPx(SCREENS["/posts"]));
    expect(bulk).toBe(headerColumnInsetPx(SCREENS["/prompts"]));
  });

  it("is the 24px that puts all three titles at x=360 on a 1440 screen", () => {
    // Spelled out so the test still fails the day all three drift together —
    // which would be the same regression, just uniform.
    for (const relative of Object.values(SCREENS)) {
      expect(headerColumnInsetPx(relative)).toBe(24);
    }
  });

  it("keeps /bulk's header column on the same inline edge as its content column", () => {
    // The disagreement this test exists to catch is visible WITHOUT switching
    // screens: the title used to start 16px right of the cards underneath it.
    const source = readFileSync(fileURLToPath(new URL(SCREENS["/bulk"], import.meta.url)), "utf8");
    const contentColumn = /className="relative mx-auto w-full max-w-5xl[^"]*"/.exec(source);

    expect(contentColumn, "/bulk no longer has its centred content column").not.toBeNull();
    expect(contentColumn![0]).toContain("px-6");
    expect(headerColumnInsetPx(SCREENS["/bulk"])).toBe(24);
  });

  it("keeps /bulk's vertical padding stated once, at the 32px it renders", () => {
    // The other half of the same fix: `padding={0}` + `py-8`, not 16 stacked on
    // 16. If `padding={0}` goes, the band silently grows to 48px.
    const source = readFileSync(fileURLToPath(new URL(SCREENS["/bulk"], import.meta.url)), "utf8");

    expect(source).toMatch(/<LayoutHeader[^>]*padding=\{0\}/);
    expect(source).toMatch(/className="[^"]*\bpy-8\b[^"]*"/);
  });
});
