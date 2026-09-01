import { describe, expect, it } from "vitest";

import {
  COLOR_SCHEME_BOOTSTRAP_SCRIPT,
  COLOR_SCHEME_CHOICES,
  COLOR_SCHEME_COOKIE,
  COLOR_SCHEME_LABELS,
  DARK_SCHEME_CLASS,
  DEFAULT_COLOR_SCHEME_CHOICE,
  buildColorSchemeCookie,
  isColorSchemeChoice,
  parseColorSchemeCookie,
  resolveColorSchemeOnServer,
} from "../color-scheme";

/**
 * Edge cases first: this parser runs in front of EVERY page in the app, so the
 * one thing it must never do is throw or invent a scheme.
 */

describe("parseColorSchemeCookie", () => {
  it.each(COLOR_SCHEME_CHOICES)("keeps the valid choice %s", (choice) => {
    expect(parseColorSchemeCookie(choice)).toBe(choice);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "  "],
    ["wrong case", "Dark"],
    ["a legacy boolean", "true"],
    ["something typed into devtools", "'; DROP TABLE"],
  ])("falls back to the default for %s", (_label, value) => {
    expect(parseColorSchemeCookie(value)).toBe(DEFAULT_COLOR_SCHEME_CHOICE);
  });

  it("defaults to following the operating system, not to light", () => {
    // Defaulting to light would hand a white page to everybody on a dark
    // desktop until they found the toggle.
    expect(DEFAULT_COLOR_SCHEME_CHOICE).toBe("system");
  });
});

describe("isColorSchemeChoice", () => {
  it("rejects non-strings", () => {
    for (const value of [null, undefined, 0, 1, {}, [], true]) {
      expect(isColorSchemeChoice(value)).toBe(false);
    }
  });
});

describe("resolveColorSchemeOnServer", () => {
  it("commits to an explicit choice", () => {
    expect(resolveColorSchemeOnServer("dark")).toBe("dark");
    expect(resolveColorSchemeOnServer("light")).toBe("light");
  });

  it("refuses to guess for system — that is the bootstrap script's job", () => {
    // Answering "light" here is what produces a white flash on a dark desktop.
    expect(resolveColorSchemeOnServer("system")).toBeNull();
  });
});

describe("buildColorSchemeCookie", () => {
  it("carries the choice, a path and a long life", () => {
    const cookie = buildColorSchemeCookie("dark", { secure: true });

    expect(cookie).toContain(`${COLOR_SCHEME_COOKIE}=dark`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("omits Secure on plain http, where the browser would drop the cookie", () => {
    expect(buildColorSchemeCookie("light", { secure: false })).not.toContain("Secure");
    expect(buildColorSchemeCookie("light", { secure: true })).toContain("Secure");
  });

  it("never writes a value the parser would refuse", () => {
    // @ts-expect-error — the guard is what stops a bad value reaching the wire.
    const cookie = buildColorSchemeCookie("neon", { secure: false });
    expect(cookie).toContain(`${COLOR_SCHEME_COOKIE}=${DEFAULT_COLOR_SCHEME_CHOICE}`);
  });
});

describe("the bootstrap script", () => {
  it("adds the class globals.css actually keys on", () => {
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT).toContain(`'${DARK_SCHEME_CLASS}'`);
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT).toContain("prefers-color-scheme: dark");
  });

  it("cannot throw — it blocks parsing on every route, sign-in included", () => {
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT).toMatch(/^try\{/);
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT).toMatch(/catch\(e\)\{\}$/);
  });

  it("carries no closing script tag that could end the block early", () => {
    // Inlined with dangerouslySetInnerHTML: a "</script>" anywhere in it would
    // terminate the tag and dump the rest onto the page as text.
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT.toLowerCase()).not.toContain("</script");
  });

  it("stays small — it is parsed before anything is painted", () => {
    expect(COLOR_SCHEME_BOOTSTRAP_SCRIPT.length).toBeLessThan(200);
  });
});

describe("labels", () => {
  it("names every choice in Vietnamese", () => {
    for (const choice of COLOR_SCHEME_CHOICES) {
      expect(COLOR_SCHEME_LABELS[choice], choice).toBeTruthy();
    }
  });
});
