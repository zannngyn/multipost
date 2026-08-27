import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `sr-only` is `position: absolute`. An absolutely positioned box anchors to the
 * nearest POSITIONED ancestor — and if the scroll container it lives in is
 * `position: static`, it escapes that container and lands at its un-scrolled
 * static position on whatever is positioned above it. Astryx's content element
 * is static, so every visually hidden line deep in a long screen was being
 * measured against the shell: `documentElement.scrollHeight` read 3625px on the
 * job log and 1382px on /sync against a 900px viewport, and the whole page could
 * be dragged down onto a band of empty background. Nothing visible moved, which
 * is why it survived a design pass.
 *
 * The cure is one word — `relative` on the box that scrolls — and it is the kind
 * of word a tidy-up deletes because nothing on screen changes when it goes. So
 * it is pinned here.
 *
 * WHAT THIS DOES NOT BUY: it only knows about the files listed below. A NEW
 * screen that opens its own scroll container will not fail this test. The check
 * that would catch that one lives in the browser (document height vs viewport),
 * not in a unit test, and this repo has no jsdom to run it in
 * (`vitest.config.ts` → `environment: "node"`).
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every `className="…"` literal in a file, comments already gone. */
function classStrings(code: string): string[] {
  return [...code.matchAll(/className=(?:"([^"]*)"|\{cn\(\s*"([^"]*)")/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

/**
 * THE SHELL-LEVEL CURE (ruling T6). `LayoutContent` is the box that scrolls on
 * nearly every screen in this app, so it is positioned ONCE in the theme rather
 * than patched screen by screen. The local `relative`s below stay: they sit on
 * scroll containers those screens open THEMSELVES, which the theme rule knows
 * nothing about. What changes is that a new screen built on the ordinary Layout
 * frame is born safe instead of one audit away from the same bug.
 */
describe("the shared Layout scroll box is positioned by the theme", () => {
  it("declares it in the theme source", () => {
    const theme = stripComments(readSource("../../../theme/mysp-theme.ts"));

    expect(theme).toMatch(/"layout-content":\s*\{/);
    expect(theme).toMatch(/position:\s*"relative"/);
  });

  it("and SHIPS it — the built stylesheet is what the browser reads", () => {
    // `mysp.css` is generated and committed, so the source alone proves nothing
    // until it has been rebuilt. `pnpm theme:check` guards the other direction.
    const css = readSource("../../../theme/mysp.css");
    const rule = css.match(/\.astryx-layout-content\s*\{[^}]*\}/);

    expect(rule, "the built theme has no .astryx-layout-content rule").not.toBeNull();
    expect(rule![0]).toMatch(/position:\s*relative/);
  });
});

describe("page-level scroll containers are positioned", () => {
  it("AppFrame gives every screen a positioned box to hang absolutes on", () => {
    const code = stripComments(readSource("../AppFrame.tsx"));
    /*
      The wrapper AppShell's own content element does not provide.

      MATCHED ON THE CLASSES, NOT ON THE WHOLE ATTRIBUTE. It used to be a bare
      `className="relative h-full min-h-0"`; since the onboarding handoff it is
      a `cn()` call whose FIRST argument is that same string plus one optional
      class. The three that matter are still stated literally and still on the
      element that wraps `{children}` — which is the entire claim. Pinning the
      old exact-attribute form would have failed on a change that kept every
      property it exists to protect.
    */
    expect(code).toMatch(/"relative h-full min-h-0"/);
    expect(code).toContain("{children}");
  });

  describe.each([
    ["../../compose/ComposeFocus.tsx"],
    ["../../sync/SyncScreen.tsx"],
  ])("%s", (file) => {
    it("marks each of its own scroll containers relative", () => {
      const scrollers = classStrings(stripComments(readSource(file))).filter((value) =>
        value.includes("overflow-y-auto"),
      );
      // If this is 0 the screen stopped owning its scrolling and the entry
      // above is stale — worth failing rather than passing vacuously.
      expect(scrollers.length).toBeGreaterThan(0);
      for (const value of scrollers) {
        expect(value).toMatch(/(^|\s)relative(\s|$)/);
      }
    });
  });
});
