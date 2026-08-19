import enCatalog from "@astryxdesign/core/locales/en.json";
import { describe, expect, it } from "vitest";

import { ASTRYX_VI } from "@/ui/i18n/astryx-vi";

/**
 * The catalog is a list of keys owned by someone else. An Astryx upgrade that
 * renames or drops one would not fail the build — the string would simply
 * revert to English, in one corner of one screen, and nobody would notice.
 * These tests are the alarm for that.
 */

const EN: Record<string, { defaultMessage: string; description?: string }> = enCatalog;

describe("ASTRYX_VI", () => {
  it("only translates keys Astryx still ships", () => {
    const unknown = Object.keys(ASTRYX_VI).filter((key) => !(key in EN));
    expect(unknown).toEqual([]);
  });

  it("keeps each description in step with the English catalog", () => {
    for (const [key, entry] of Object.entries(ASTRYX_VI)) {
      // A stale description is how a translation quietly ends up answering a
      // question the string no longer asks.
      expect(entry.description, key).toBe(EN[key]?.description);
    }
  });

  it("carries over every ICU argument, so no value goes missing", () => {
    /**
     * Argument names only. Plural and select BRANCHES are stripped first:
     * English writes `{count, plural, one {result} other {results}}`, and
     * "result"/"results" are literal text, not values. Vietnamese has one
     * plural form, so collapsing that branch to a bare count is the correct
     * translation — the test must not read it as a dropped value.
     */
    const argumentsOf = (message: string) => {
      const withoutBranches = message.replace(
        /\b(zero|one|two|few|many|other|=\d+)\s*\{[^{}]*\}/g,
        "",
      );
      return [...new Set([...withoutBranches.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]))].sort();
    };

    for (const [key, entry] of Object.entries(ASTRYX_VI)) {
      expect(argumentsOf(entry.defaultMessage), key).toEqual(
        argumentsOf(EN[key]?.defaultMessage ?? ""),
      );
    }
  });

  it("keeps every message structurally valid ICU", () => {
    /**
     * A structural check, not a parse: Astryx exports no ICU compiler and
     * `intl-messageformat` is its transitive dependency, not ours. `resolve()`
     * builds the formatter with no try/catch, so a malformed message throws at
     * render instead of falling back to English — unbalanced braces are worth
     * catching here even without a full parser.
     */
    for (const [key, entry] of Object.entries(ASTRYX_VI)) {
      let depth = 0;
      for (const char of entry.defaultMessage) {
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        expect(depth, `${key}: closing brace with nothing open`).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${key}: unclosed brace`).toBe(0);
    }
  });

  it("keeps every argument English formats as a number formatted as one", () => {
    /**
     * `{count} kết quả` would pass the argument-name check and still be wrong:
     * it prints 1234 where the operator should read 1.234. Anything English
     * types `number` or counts with `plural` has to stay numeric here.
     */
    const numericArgs = (message: string) =>
      [...new Set([...message.matchAll(/\{\s*(\w+)\s*,\s*(?:number|plural)\b/g)].map((m) => m[1]))]
        .sort();

    for (const [key, entry] of Object.entries(ASTRYX_VI)) {
      expect(numericArgs(entry.defaultMessage), key).toEqual(
        numericArgs(EN[key]?.defaultMessage ?? ""),
      );
    }
  });

  it("actually translates — no entry left at its English text", () => {
    for (const [key, entry] of Object.entries(ASTRYX_VI)) {
      expect(entry.defaultMessage, key).not.toBe(EN[key]?.defaultMessage);
    }
  });

  it("lists no key the app already labels with its own prop", () => {
    // Each of these is passed explicitly at the call site, so a catalog entry
    // would never be read — it would only be a second spelling to drift from.
    for (const key of [
      "@astryx.sideNav.label",
      "@astryx.topNav.landmarkLabel",
      "@astryx.commandPalette.label",
      "@astryx.commandPalette.emptySearch",
      "@astryx.dropdownMenu.label",
    ]) {
      expect(ASTRYX_VI[key], key).toBeUndefined();
    }
  });

  it("covers the shell strings an operator can actually see", () => {
    // The two the redesign set out to fix, pinned so a refactor cannot drop them.
    expect(ASTRYX_VI["@astryx.sideNavCollapseButton.collapseSidebar"]?.defaultMessage).toBe(
      "Thu gọn thanh bên",
    );
    expect(ASTRYX_VI["@astryx.commandPalette.input.placeholder"]?.defaultMessage).toBe("Tìm…");
  });

  it("has an entry for both halves of every paired toggle", () => {
    // Half a pair reads as a bug the moment the control flips state.
    const pairs = [
      ["@astryx.sideNavCollapseButton.collapseSidebar", "@astryx.sideNavCollapseButton.expandSidebar"],
      ["@astryx.sideNavItem.collapse", "@astryx.sideNavItem.expand"],
      ["@astryx.mobileNav.toggle.open", "@astryx.mobileNav.closeNavigation"],
    ];

    for (const [a, b] of pairs) {
      expect(Boolean(ASTRYX_VI[a]), a).toBe(Boolean(ASTRYX_VI[b]));
    }
  });
});
