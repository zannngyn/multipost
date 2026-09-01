import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The `/posts` hub was the last screen still hand-rolling its page container
 * (`<div className="space-y-6">` inside a `max-w-5xl` wrapper on the page),
 * while `/channels`, `/members`, `/bulk` and `/prompts` all stand in an Astryx
 * `Layout` with a full-width header band (spec §3.2 — khung màn thống nhất).
 *
 * Two invariants, and the second one is a trap this repo has now been bitten by
 * three times (AppFrame, BulkRunScreen, here):
 *
 *   1. the frame is `Layout` + `LayoutHeader` + `LayoutContent`, and the page
 *      adds NO container of its own — a wrapper would sit inside the frame and
 *      bound the header band, so the divider would stop short of the shell edge;
 *
 *   2. the scrolling content box is `position: relative`. `sr-only` is
 *      `position: absolute`, so every visually hidden node inside anchors to the
 *      nearest POSITIONED ancestor; with a static box they escape the scroll
 *      container, land on the shell wrapper above it, stretch
 *      `documentElement.scrollHeight` past the viewport and hand the page a
 *      second scrollbar with nothing but background in it. Nothing visible
 *      moves, so the only symptom is a scrollbar that should not exist.
 *
 * Structural, not rendering: `vitest.config.ts` runs `environment: "node"` and
 * the repo has no jsdom — same call as `members/members-hub-sweep.test.ts`.
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("/posts hub: the shared Astryx frame", () => {
  const hub = stripComments(readSource("../PostsHub.tsx"));

  it("stands in Layout + LayoutHeader + LayoutContent", () => {
    expect(hub).toMatch(/<Layout\b/);
    expect(hub).toMatch(/<LayoutHeader\b[^>]*hasDivider/);
    expect(hub).toMatch(/<LayoutContent\b/);
  });

  it("no longer hand-rolls a page container or a raw h1", () => {
    expect(hub).not.toMatch(/className="space-y-6"/);
    expect(hub).not.toMatch(/<h1\b/);
    expect(hub).toMatch(/<Heading level=\{1\}>/);
  });

  it("keeps the tab strip labelled, in the header band", () => {
    expect(hub).toMatch(/<TabList[\s\S]*?aria-label="Chế độ xem bài đăng"/);
  });

  it("gives the scrolling content box a positioning context (sr-only trap)", () => {
    expect(hub).toMatch(/<LayoutContent[^>]*isScrollable/);
    expect(hub).toMatch(/className="relative mx-auto w-full max-w-5xl/);
  });
});

describe("/posts page: the frame belongs to the hub, not to the route", () => {
  const page = stripComments(readSource("../../../../app/(app)/posts/page.tsx"));

  it("wraps the hub in nothing but its Suspense boundary", () => {
    expect(page).toMatch(/<Suspense[\s\S]*?<PostsHub tab=\{tab\} \/>[\s\S]*?<\/Suspense>/);
    // The old container. `PostsFallback` still draws a column of the same
    // width — that one is the skeleton's own body, not a wrapper around the hub.
    expect(page).not.toMatch(/max-w-5xl[^"]*">\s*<Suspense/);
  });

  it("keeps the fallback on the same column as the loaded frame", () => {
    expect(page).toMatch(/mx-auto w-full max-w-5xl[^"]*px-6 py-4/);
    expect(page).toMatch(/mx-auto w-full max-w-5xl[^"]*px-6 py-8/);
  });
});

describe("/prompts page: same split", () => {
  const page = stripComments(readSource("../../../../app/(app)/prompts/page.tsx"));

  it("renders the screen with no container of its own", () => {
    expect(page).toMatch(/return <PromptTemplatesScreen \/>;/);
    expect(page).not.toMatch(/max-w-5xl/);
  });
});
