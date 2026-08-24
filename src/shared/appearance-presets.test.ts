import { describe, expect, it } from "vitest";

import {
  APPEARANCE_PRESETS,
  APPEARANCE_SURFACES,
  APPEARANCE_TOKEN_NAMES,
  DEFAULT_APPEARANCE_PRESET_ID,
  derivePresetColors,
  derivePresetTokens,
  findAppearancePreset,
  isAppearancePresetId,
  type AppearanceScheme,
  type OklchColor,
} from "./appearance-presets";

/**
 * The gate on the preset table. A preset is a colour a non-designer can put on
 * the WHOLE product from a settings screen, so the table has to be provably
 * safe rather than reviewed by eye:
 *
 *   1. every colour must be inside sRGB — outside it the browser clips, and
 *      clipping moves lightness, which voids rule 3;
 *   2. every text/surface pair must clear 4.5:1 in BOTH schemes;
 *   3. no preset may move lightness — that is the invariant the whole
 *      "presets cannot break contrast" argument rests on.
 *
 * The conversion below is the standard OKLab → linear sRGB matrix. It is
 * checked against a value the repo measured independently: `globals.css` says
 * the primary button is 7.19:1 light and 5.99:1 dark, and the `cham` case
 * reproduces both — so a bug in this maths would fail loudly here rather than
 * quietly bless a bad palette.
 */

function toLinearSrgb(color: OklchColor): [number, number, number] {
  const hueRadians = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hueRadians);
  const b = color.c * Math.sin(hueRadians);

  const lRoot = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Half a 16-bit step of slack, so exact-boundary colours are not "outside". */
const GAMUT_EPSILON = 0.0005;

function isInSrgbGamut(color: OklchColor): boolean {
  return toLinearSrgb(color).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
  );
}

/** WCAG relative luminance. Linear channels already; only the clamp is needed. */
function relativeLuminance(color: OklchColor): number {
  const [r, g, b] = toLinearSrgb(color).map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: OklchColor, b: OklchColor): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

const SCHEMES: readonly AppearanceScheme[] = ["light", "dark"];

/** WCAG AA for body text — the bar every pair below has to clear. */
const MIN_CONTRAST = 4.5;

describe("appearance preset table", () => {
  it("has the approved direction as its default", () => {
    expect(DEFAULT_APPEARANCE_PRESET_ID).toBe("cham");
    expect(isAppearancePresetId(DEFAULT_APPEARANCE_PRESET_ID)).toBe(true);
  });

  it("has unique ids", () => {
    const ids = APPEARANCE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects anything that is not a preset id", () => {
    for (const value of ["", "CHAM", "indigo", null, undefined, 7, {}]) {
      expect(isAppearancePresetId(value)).toBe(false);
    }
  });

  it("throws rather than guessing for an unknown id", () => {
    // @ts-expect-error — the guard above is what stops this in production.
    expect(() => findAppearancePreset("nope")).toThrow(/Unknown appearance preset/);
  });
});

describe.each(SCHEMES)("preset colours (%s scheme)", (scheme) => {
  it.each(APPEARANCE_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s stays inside sRGB",
    (_id, preset) => {
      for (const [role, color] of Object.entries(derivePresetColors(preset, scheme))) {
        expect(
          isInSrgbGamut(color),
          `${preset.id}/${scheme}/${role} is outside sRGB — lower its chromaScale`,
        ).toBe(true);
      }
    },
  );

  it.each(APPEARANCE_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s keeps every text pair at or above 4.5:1",
    (_id, preset) => {
      const colors = derivePresetColors(preset, scheme);
      const { ground, card } = APPEARANCE_SURFACES[scheme];

      const pairs: readonly (readonly [string, OklchColor, OklchColor])[] = [
        // The label on a primary button.
        ["dye ink on the dye", colors.dyeInk, colors.dye],
        // An accented word / link, on both surfaces it can land on.
        ["the dye on the cloth", colors.dye, ground],
        ["the dye on a card", colors.dye, card],
        // A selected nav row: its own ink on its own tint.
        ["wash ink on the wash", colors.washInk, colors.wash],
      ];

      for (const [what, foreground, background] of pairs) {
        const ratio = contrastRatio(foreground, background);
        expect(
          ratio,
          `${preset.id}/${scheme}: ${what} is ${ratio.toFixed(2)}:1, under ${MIN_CONTRAST}:1`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    },
  );

  it("never moves lightness — the invariant the contrast argument rests on", () => {
    const base = derivePresetColors(findAppearancePreset(DEFAULT_APPEARANCE_PRESET_ID), scheme);

    for (const preset of APPEARANCE_PRESETS) {
      const colors = derivePresetColors(preset, scheme);
      for (const role of Object.keys(base) as (keyof typeof base)[]) {
        expect(colors[role].l, `${preset.id}/${scheme}/${role} moved its lightness`).toBe(
          base[role].l,
        );
      }
    }
  });
});

describe("the default preset reproduces globals.css", () => {
  const cham = findAppearancePreset(DEFAULT_APPEARANCE_PRESET_ID);

  it("emits the light values the palette already ships", () => {
    const tokens = derivePresetTokens(cham, "light");

    expect(tokens["--primary"]).toBe("oklch(0.45 0.105 262)");
    expect(tokens["--primary-foreground"]).toBe("oklch(0.984 0.007 84)");
    expect(tokens["--accent"]).toBe("oklch(0.89 0.045 262)");
    expect(tokens["--accent-foreground"]).toBe("oklch(0.38 0.11 263)");
    expect(tokens["--ring"]).toBe("oklch(0.45 0.105 262 / 45%)");
    expect(tokens["--sidebar-primary"]).toBe("oklch(0.45 0.105 262)");
    expect(tokens["--sidebar-accent-foreground"]).toBe("oklch(0.38 0.11 263)");
  });

  it("emits the dark values the palette already ships", () => {
    const tokens = derivePresetTokens(cham, "dark");

    expect(tokens["--primary"]).toBe("oklch(0.68 0.09 262)");
    expect(tokens["--primary-foreground"]).toBe("oklch(0.22 0.03 262)");
    expect(tokens["--accent"]).toBe("oklch(0.36 0.075 262)");
    expect(tokens["--accent-foreground"]).toBe("oklch(0.86 0.06 262)");
    expect(tokens["--ring"]).toBe("oklch(0.68 0.09 262 / 50%)");
    expect(tokens["--chart-1"]).toBe("oklch(0.68 0.09 262)");
  });

  it("agrees with the ratios globals.css measured independently", () => {
    const light = derivePresetColors(cham, "light");
    const dark = derivePresetColors(cham, "dark");

    // "contrast on the primary button is 7.19:1 light and 5.99:1 dark"
    // — src/ui/theme/mysp-theme.ts, measured before this file existed.
    expect(contrastRatio(light.dyeInk, light.dye)).toBeCloseTo(7.19, 1);
    expect(contrastRatio(dark.dyeInk, dark.dye)).toBeCloseTo(5.99, 1);
  });
});

describe("token coverage", () => {
  it("sets every dye-cut variable in both schemes", () => {
    for (const scheme of SCHEMES) {
      for (const preset of APPEARANCE_PRESETS) {
        const tokens = derivePresetTokens(preset, scheme);
        expect(Object.keys(tokens).sort()).toEqual([...APPEARANCE_TOKEN_NAMES].sort());
        for (const name of APPEARANCE_TOKEN_NAMES) {
          expect(tokens[name], `${preset.id}/${scheme}/${name}`).toMatch(/^oklch\(/);
        }
      }
    }
  });

  it("leaves the status hues alone — a status colour must not follow the brand", () => {
    for (const name of APPEARANCE_TOKEN_NAMES) {
      expect(["--chart-2", "--chart-3", "--chart-4", "--chart-5"]).not.toContain(name);
      expect(name).not.toMatch(/destructive|warning|success|info/);
    }
  });
});
