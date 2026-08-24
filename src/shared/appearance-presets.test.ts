import { describe, expect, it } from "vitest";

import {
  APPEARANCE_PRESETS,
  APPEARANCE_TOKEN_NAMES,
  DEFAULT_APPEARANCE_PRESET_ID,
  derivePresetColors,
  derivePresetTokens,
  findAppearancePreset,
  isAppearancePresetId,
  isInSrgbGamut,
  type AppearanceScheme,
  type OklchColor,
} from "./appearance-presets";

/**
 * The gate on the preset table. A preset repaints the WHOLE product from a
 * settings screen, so the table has to be provably safe rather than reviewed by
 * eye:
 *
 *   1. no preset may move LIGHTNESS — the invariant the whole "presets cannot
 *      break contrast" argument rests on;
 *   2. every colour must be inside sRGB — outside it the browser clips, and
 *      clipping moves lightness, which voids rule 1;
 *   3. every text/surface pair must clear 4.5:1 in BOTH schemes, measured
 *      against that preset's OWN ground and cards, not against the original's.
 *
 * The conversion below is an independent re-implementation of the one in the
 * module: if both drifted the same way this test would bless a bad palette, so
 * it is also checked against a number the repo measured before either existed —
 * `mysp-theme.ts` records the primary button at 7.19:1 light and 5.99:1 dark,
 * and the `cham` case reproduces both.
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

/** WCAG relative luminance. Linear channels already; only the clamp is needed. */
function relativeLuminance(color: OklchColor): number {
  const [r, g, b] = toLinearSrgb(color).map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: OklchColor, b: OklchColor): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const SCHEMES: readonly AppearanceScheme[] = ["light", "dark"];

/** WCAG AA for body text — the bar every pair below has to clear. */
const MIN_CONTRAST = 4.5;

const EVERY_PRESET = APPEARANCE_PRESETS.map((preset) => [preset.id, preset] as const);

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

  it("keeps ink far less tinted than the paper it sits on", () => {
    // Not cosmetic: ink as saturated as the surface stops reading as ink. The
    // table is allowed to tint the cloth hard, never the text.
    for (const preset of APPEARANCE_PRESETS) {
      expect(preset.inkChromaScale, preset.id).toBeLessThanOrEqual(preset.surfaceChromaScale);
    }
  });
});

describe.each(SCHEMES)("preset colours (%s scheme)", (scheme) => {
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

  it.each(EVERY_PRESET)("%s stays inside sRGB", (_id, preset) => {
    for (const [role, color] of Object.entries(derivePresetColors(preset, scheme))) {
      expect(
        isInSrgbGamut(color),
        `${preset.id}/${scheme}/${role} is outside sRGB — the clamp failed`,
      ).toBe(true);
    }
  });

  it.each(EVERY_PRESET)("%s keeps every text pair at or above 4.5:1", (_id, preset) => {
    const c = derivePresetColors(preset, scheme);

    // Measured against THIS preset's own ground and cards: a preset that tints
    // the paper changes both sides of every ratio.
    const pairs: readonly (readonly [string, OklchColor, OklchColor])[] = [
      ["body ink on the ground", c.ink, c.ground],
      ["body ink on a card", c.ink, c.card],
      ["body ink on a sunken panel", c.ink, c.sunken],
      ["supporting ink on the ground", c.inkMuted, c.ground],
      ["supporting ink on a card", c.inkMuted, c.card],
      // The tightest pair in the palette — 4.65:1 in the original, and the one
      // a careless tint would push under the bar first.
      ["subtle ink on the ground", c.inkSubtle, c.ground],
      ["subtle ink on a card", c.inkSubtle, c.card],
      // An accented word / link, on both surfaces it can land on.
      ["the dye on the ground", c.dye, c.ground],
      ["the dye on a card", c.dye, c.card],
      // The label on a primary button.
      ["dye ink on the dye", c.dyeInk, c.dye],
      // A selected row: its own ink on its own tint, and body ink over it too.
      ["wash ink on the wash", c.washInk, c.wash],
      ["body ink on the wash", c.ink, c.wash],
    ];

    for (const [what, foreground, background] of pairs) {
      const ratio = contrastRatio(foreground, background);
      expect(
        ratio,
        `${preset.id}/${scheme}: ${what} is ${ratio.toFixed(2)}:1, under ${MIN_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it.each(EVERY_PRESET)("%s keeps a card distinguishable from the ground", (_id, preset) => {
    const c = derivePresetColors(preset, scheme);
    // The design stands cards a step off the ground. A tint that flattened that
    // step would erase the layering without failing any contrast rule.
    expect(c.card.l, preset.id).not.toBe(c.ground.l);
  });
});

describe("the default preset reproduces globals.css", () => {
  const cham = findAppearancePreset(DEFAULT_APPEARANCE_PRESET_ID);

  it("emits the light values the palette already ships", () => {
    const tokens = derivePresetTokens(cham, "light");

    expect(tokens["--background"]).toBe("oklch(0.955 0.013 84)");
    expect(tokens["--foreground"]).toBe("oklch(0.28 0.018 55)");
    expect(tokens["--foreground-subtle"]).toBe("oklch(0.53 0.02 60)");
    expect(tokens["--card"]).toBe("oklch(0.984 0.007 84)");
    expect(tokens["--muted"]).toBe("oklch(0.933 0.014 84)");
    expect(tokens["--muted-foreground"]).toBe("oklch(0.47 0.02 58)");
    expect(tokens["--border"]).toBe("oklch(0.28 0.018 55 / 12%)");
    expect(tokens["--input"]).toBe("oklch(0.28 0.018 55 / 16%)");
    expect(tokens["--primary"]).toBe("oklch(0.45 0.105 262)");
    expect(tokens["--primary-foreground"]).toBe("oklch(0.984 0.007 84)");
    expect(tokens["--accent"]).toBe("oklch(0.89 0.045 262)");
    expect(tokens["--accent-foreground"]).toBe("oklch(0.38 0.11 263)");
    expect(tokens["--ring"]).toBe("oklch(0.45 0.105 262 / 45%)");
    expect(tokens["--media-empty"]).toBe("oklch(0.92 0.02 84)");
    expect(tokens["--sidebar-accent-foreground"]).toBe("oklch(0.38 0.11 263)");
  });

  it("emits the dark values the palette already ships", () => {
    const tokens = derivePresetTokens(cham, "dark");

    expect(tokens["--background"]).toBe("oklch(0.24 0.012 60)");
    expect(tokens["--foreground"]).toBe("oklch(0.94 0.01 84)");
    expect(tokens["--card"]).toBe("oklch(0.28 0.014 60)");
    expect(tokens["--muted-foreground"]).toBe("oklch(0.72 0.016 65)");
    expect(tokens["--border"]).toBe("oklch(1 0 0 / 12%)");
    expect(tokens["--primary"]).toBe("oklch(0.68 0.09 262)");
    expect(tokens["--primary-foreground"]).toBe("oklch(0.22 0.03 262)");
    expect(tokens["--accent"]).toBe("oklch(0.36 0.075 262)");
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
    // "4.65:1 on the cloth ground and 5.07:1 on a card" — globals.css on
    // --foreground-subtle, the tightest pair in the palette.
    expect(contrastRatio(light.inkSubtle, light.ground)).toBeCloseTo(4.65, 1);
    expect(contrastRatio(light.inkSubtle, light.card)).toBeCloseTo(5.07, 1);
  });
});

describe("what a preset must NOT repaint", () => {
  it("leaves every status hue alone — a status colour must not follow the brand", () => {
    for (const name of APPEARANCE_TOKEN_NAMES) {
      expect(["--chart-2", "--chart-3", "--chart-4", "--chart-5"]).not.toContain(name);
      expect(name).not.toMatch(/destructive|warning|success|info/);
    }
  });

  it("covers every surface, ink and hairline in both schemes", () => {
    // The list a preset MUST reach. A token missing here is a panel that keeps
    // the old theme's colour while everything around it changed — the exact
    // half-repainted look this feature exists to avoid.
    const required = [
      "--background",
      "--foreground",
      "--foreground-subtle",
      "--card",
      "--card-foreground",
      "--popover",
      "--popover-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--border",
      "--input",
      "--sidebar",
      "--sidebar-foreground",
      "--sidebar-border",
      "--media-empty",
      "--media-empty-cover",
      "--primary",
      "--accent",
      "--ring",
    ];

    for (const name of required) {
      expect(APPEARANCE_TOKEN_NAMES, `${name} is not repainted by a preset`).toContain(name);
    }
  });

  it("emits every token as a valid oklch value in both schemes", () => {
    for (const scheme of SCHEMES) {
      for (const preset of APPEARANCE_PRESETS) {
        const tokens = derivePresetTokens(preset, scheme);
        expect(Object.keys(tokens).sort()).toEqual([...APPEARANCE_TOKEN_NAMES].sort());
        for (const name of APPEARANCE_TOKEN_NAMES) {
          expect(tokens[name], `${preset.id}/${scheme}/${name}`).toMatch(
            /^oklch\(-?[\d.]+ [\d.]+ [\d.]+( \/ [\d.]+%)?\)$/,
          );
        }
      }
    }
  });
});
