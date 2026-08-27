import { describe, expect, it } from "vitest";

import {
  buildColorVocabulary,
  CANONICAL_COLORS,
  DEFAULT_COLOR_VOCABULARY,
  isSameColor,
  normalizeColorName,
} from "../media-colors";
import {
  DEFAULT_MEDIA_PROFILE,
  MEDIA_PROFILE_KINDS,
  mediaProfileExpectsColorInName,
  mediaProfileNeedsLinkColumn,
  mediaProfileNeedsRecursion,
  resolveMediaProfile,
  validateMediaProfile,
  type MediaProfile,
} from "../media-profile";

describe("resolveMediaProfile — edge cases first", () => {
  it.each([undefined, null, {}, { kind: "" }, { kind: "nonsense" }, 42, "code-in-name"])(
    "falls back to the internal convention for %p",
    (raw) => {
      expect(resolveMediaProfile(raw as unknown as MediaProfile)).toEqual(DEFAULT_MEDIA_PROFILE);
      expect(DEFAULT_MEDIA_PROFILE.kind).toBe("code-color-seq");
    },
  );

  it("returns a declared profile untouched", () => {
    const profile: MediaProfile = { kind: "folder-per-code" };
    expect(resolveMediaProfile(profile)).toBe(profile);
  });
});

describe("profile capabilities", () => {
  it("only the two profiles that need sub-folders ask for a recursive listing", () => {
    expect(mediaProfileNeedsRecursion({ kind: "folder-per-code" })).toBe(true);
    expect(mediaProfileNeedsRecursion({ kind: "sheet-column" })).toBe(true);
    expect(mediaProfileNeedsRecursion({ kind: "code-in-name" })).toBe(false);
    expect(mediaProfileNeedsRecursion({ kind: "code-color-seq" })).toBe(false);
    // The default must stay cheap: an absent profile is one flat listing.
    expect(mediaProfileNeedsRecursion(undefined)).toBe(false);
  });

  it("only the internal convention promises a colour in the file name", () => {
    expect(mediaProfileExpectsColorInName(undefined)).toBe(true);
    expect(mediaProfileExpectsColorInName({ kind: "code-color-seq" })).toBe(true);
    for (const kind of ["sheet-column", "folder-per-code", "code-in-name"] as const) {
      expect(mediaProfileExpectsColorInName({ kind })).toBe(false);
    }
  });

  it("only sheet-column needs the mediaLink column", () => {
    expect(mediaProfileNeedsLinkColumn({ kind: "sheet-column" })).toBe(true);
    for (const kind of ["folder-per-code", "code-in-name", "code-color-seq"] as const) {
      expect(mediaProfileNeedsLinkColumn({ kind })).toBe(false);
    }
  });
});

describe("validateMediaProfile — values, never throws", () => {
  it("accepts an absent profile (that is the default, not a mistake)", () => {
    expect(validateMediaProfile(undefined)).toEqual([]);
    expect(validateMediaProfile(null)).toEqual([]);
  });

  it("accepts every declared kind with no colour config", () => {
    for (const kind of MEDIA_PROFILE_KINDS) {
      expect(validateMediaProfile({ kind })).toEqual([]);
    }
  });

  it("blocks an unknown kind with an error the operator can read", () => {
    const issues = validateMediaProfile({ kind: "drive-magic" } as unknown as MediaProfile);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("MEDIA_PROFILE_KIND_INVALID");
    expect(issues[0].severity).toBe("error");
    expect(issues[0].detail).toContain("drive-magic");
  });

  it("warns — never blocks — when the tenant turned the defaults off with no colour of its own", () => {
    const issues = validateMediaProfile({
      kind: "code-color-seq",
      colors: { includeDefaults: false },
    });
    expect(issues.map((issue) => issue.code)).toEqual(["MEDIA_PROFILE_COLORS_EMPTY"]);
    expect(issues[0].severity).toBe("warning");
  });

  it("warns about a duplicate colour spelling and an alias pointing nowhere", () => {
    const issues = validateMediaProfile({
      kind: "code-in-name",
      colors: {
        canonical: ["Vàng chanh", "VANG CHANH"],
        aliases: { VC: "Vàng chanh", XX: "Màu không có thật" },
      },
    });
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "MEDIA_PROFILE_ALIAS_UNKNOWN",
      "MEDIA_PROFILE_COLOR_DUPLICATE",
    ]);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("accepts an alias onto a BUILT-IN colour while the defaults are on", () => {
    expect(
      validateMediaProfile({ kind: "code-color-seq", colors: { aliases: { XT: "XANH THAN" } } }),
    ).toEqual([]);
  });
});

describe("buildColorVocabulary — per tenant, seeded from the built-ins", () => {
  it("returns the built-in vocabulary when nothing is configured", () => {
    expect(buildColorVocabulary(undefined)).toBe(DEFAULT_COLOR_VOCABULARY);
    expect(buildColorVocabulary({})).toBe(DEFAULT_COLOR_VOCABULARY);
    expect(buildColorVocabulary(null)).toBe(DEFAULT_COLOR_VOCABULARY);
  });

  it("keeps the built-in behaviour: casefold, diacritics and glued spellings", () => {
    expect(normalizeColorName("trang")).toBe("TRẮNG");
    expect(normalizeColorName("XANHTHAN")).toBe("XANH THAN");
    expect(normalizeColorName("Den")).toBe("ĐEN");
    expect(normalizeColorName("không phải màu")).toBeNull();
    expect(CANONICAL_COLORS).toContain("XANH THAN");
  });

  it("adds a tenant colour without losing the built-ins", () => {
    const vocabulary = buildColorVocabulary({
      canonical: ["Vàng chanh"],
      aliases: { VC: "Vàng chanh" },
    });
    expect(vocabulary.resolve("vang chanh")).toBe("Vàng chanh");
    expect(vocabulary.resolve("vc")).toBe("Vàng chanh");
    expect(vocabulary.resolve("XANH THAN")).toBe("XANH THAN");
  });

  it("uses the tenant list ALONE when the defaults are turned off", () => {
    const vocabulary = buildColorVocabulary({
      canonical: ["Gỗ óc chó", "Gỗ sồi"],
      includeDefaults: false,
    });
    expect(vocabulary.resolve("go oc cho")).toBe("Gỗ óc chó");
    // A fashion colour is noise for this tenant — and an unknown colour is
    // simply "không phân màu", never an error.
    expect(vocabulary.resolve("XANH THAN")).toBeNull();
    expect(vocabulary.canonical).toEqual(["Gỗ óc chó", "Gỗ sồi"]);
  });

  it("compares two spellings with the tenant vocabulary, unknown ones included", () => {
    const vocabulary = buildColorVocabulary({ canonical: ["Gỗ sồi"], includeDefaults: false });
    expect(isSameColor("go soi", "Gỗ sồi", vocabulary)).toBe(true);
    // Unknown to both vocabularies but written the same: still one colour.
    expect(isSameColor("mau la", "MÀU LẠ", vocabulary)).toBe(true);
    expect(isSameColor("mau la", "khac han", vocabulary)).toBe(false);
  });
});
