import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { myspTheme } from "@/ui/theme/mysp-theme";

/**
 * The pin between `mysp-theme.ts` (the source) and `mysp.css` (what the browser
 * actually reads).
 *
 * WHY THIS TEST EXISTS (wave-1 finding M-3): the theme is BUILT, not runtime —
 * `pnpm exec astryx theme build src/ui/theme/mysp-theme.ts` compiles the source
 * into `mysp.css`, and `globals.css` imports the CSS. Nothing in the build
 * pipeline re-runs that command, so editing the source and forgetting the build
 * step is silent: types pass, lint passes, the app boots, and every Astryx
 * component keeps painting the OLD ink. The failure mode is a colour being one
 * shade off across the whole shell — the exact kind of difference nobody can
 * name and everybody sees. This test is the alarm.
 *
 * It reads the built file as text on purpose. Importing it would prove nothing:
 * only the bytes the browser downloads can answer "was the build re-run?".
 */

const CSS_PATH = new URL("./mysp.css", import.meta.url);

/**
 * The tokens whose values are OURS, not the neutral theme's — the swatch-book
 * ink and the one indigo. Everything else in `mysp.css` is inherited and moves
 * with the Astryx version, which is not this test's business.
 *
 * Adding an override to `mysp-theme.ts` without adding it here leaves that
 * token unpinned; that is a deliberate cost of listing them, and cheaper than a
 * test that re-implements `defineTheme`'s merge to guess which ones are ours.
 */
const PINNED_TOKENS = [
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-disabled",
  "--color-text-accent",
  "--color-accent",
  "--color-on-accent",
  "--color-icon-accent",
  "--color-accent-muted",
  // The ground and the surfaces standing on it. `AppShell` is the only element
  // that paints the area behind a screen, and it reads `--color-background-body`
  // — leaving that one unpinned is how a stale build puts the neutral theme's
  // cold `#F1F1F1` back under all fifteen routes with nothing failing.
  "--color-background-body",
  "--color-background-surface",
  "--color-background-card",
  "--color-background-popover",
  "--color-background-muted",
  // The Ink Hairline Rule: warm ink at 8%, not the neutral theme's cold black.
  "--color-border",
  "--color-border-emphasized",
  // Loading is one of the four mandatory states; its slabs belong to the world.
  "--color-skeleton",
  "--color-track",
] as const;

function readBuiltCss(): string {
  const css = readFileSync(CSS_PATH, "utf8");
  // Edge case first: an empty or truncated build would make every `.get()`
  // below return undefined and read as "the token is missing", which is a
  // confusing way to say "the file is broken".
  if (css.trim().length === 0) throw new Error("mysp.css is empty — re-run `astryx theme build`");
  return css;
}

/**
 * The declarations of the theme ROOT (`:scope`), not of the whole file.
 *
 * `mysp.css` re-declares several of these tokens further down, inside
 * component blocks — `.astryx-banner.info` sets its own `--color-accent`, and
 * `.astryx-badge.blue` its own `--color-text-primary`. A whole-file grep would
 * read one of those back and pass on the wrong line.
 */
function themeRootDeclarations(css: string): Map<string, string> {
  const start = css.indexOf(":scope {");
  if (start < 0) {
    throw new Error("mysp.css has no `:scope` block — the theme build output changed shape");
  }
  const end = css.indexOf("\n  }", start);
  if (end < 0) throw new Error("mysp.css `:scope` block is unterminated");

  const declarations = new Map<string, string>();
  for (const line of css.slice(start, end).split("\n")) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i.exec(line);
    if (match) declarations.set(match[1], match[2]);
  }
  return declarations;
}

describe("mysp.css is the build of mysp-theme.ts", () => {
  const declarations = themeRootDeclarations(readBuiltCss());

  it.each(PINNED_TOKENS)("%s in the built CSS is the value the source defines", (token) => {
    const source = myspTheme.tokens[token];
    expect(source, `${token} is not defined in mysp-theme.ts`).toBeTypeOf("string");
    expect(
      declarations.get(token),
      `mysp.css is stale for ${token} — re-run \`pnpm exec astryx theme build src/ui/theme/mysp-theme.ts\``,
    ).toBe(source);
  });

  /**
   * The override itself, not just the build. Deleting a token from the source
   * and re-running the build would leave the two files agreeing again — on the
   * neutral theme's cold near-black, which is the bug the theme exists to fix.
   * Every one of ours points at the class-switched swatch palette in
   * `globals.css`; a neutral default is a literal hex or `light-dark(...)`.
   */
  it.each(PINNED_TOKENS)("%s still points at the swatch palette, not a literal", (token) => {
    expect(declarations.get(token) ?? "").toMatch(/^(var\(--|color-mix\()/);
  });

  it("declares itself generated, which is why the detector skips it", () => {
    // `.impeccable/config.json` ignores this file wholesale: its literals are
    // the Astryx neutral palette, not design drift. That exemption is only
    // honest while the file really is machine-written.
    const header = readBuiltCss().slice(0, 400);
    expect(header).toContain("@generated");
    expect(header).toContain("src/ui/theme/mysp-theme.ts");
  });
});
