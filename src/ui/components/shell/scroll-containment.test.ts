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

describe("page-level scroll containers are positioned", () => {
  it("AppFrame gives every screen a positioned box to hang absolutes on", () => {
    const code = stripComments(readSource("./AppFrame.tsx"));
    // The wrapper AppShell's own content element does not provide.
    expect(code).toMatch(/className="relative h-full min-h-0"/);
    expect(code).toContain("{children}");
  });

  describe.each([
    ["../compose/ComposeFocus.tsx"],
    ["../sync/SyncScreen.tsx"],
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
