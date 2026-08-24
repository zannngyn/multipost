/**
 * The colour presets an MYSP platform admin may put on the whole app.
 *
 * WHY A TABLE OF HUES AND NOT A TABLE OF COLOURS: a preset is the approved
 * "Sổ mẫu vải" palette with ONE number moved — the hue of the dye. Lightness is
 * carried over from `app/globals.css` untouched, and lightness is what carries
 * contrast, so a preset cannot quietly turn a readable button into an
 * unreadable one. That is the whole safety argument for letting a non-designer
 * repaint the product from a screen, and it is CHECKED, not asserted:
 * `appearance-presets.test.ts` measures every pair in both schemes.
 *
 * WHY CHROMA IS SCALED PER PRESET: sRGB does not hold the same chroma at every
 * hue. Teal at L 0.45 tops out well below the indigo's 0.105, and a value
 * outside the gamut is silently clipped by the browser — which moves lightness
 * behind our back and voids the argument above. Each preset therefore carries
 * the largest scale that keeps EVERY token it touches inside sRGB (measured,
 * not guessed). Ratios stay ≥ 4.86:1 across the whole table.
 *
 * WHY IT LIVES IN `shared/`: the CSS generator (a script), the usecase that
 * validates what is stored (core) and the screen that draws the swatches (ui)
 * all need the SAME list, and `ui` may import nothing but `@/shared` and
 * `@/ui` (eslint.config.mjs). One table, three readers — the alternative is
 * three copies that drift apart on the first new preset.
 *
 * ADDING A PRESET: add the row, run `pnpm run theme:presets`, run the tests.
 * The test refuses a row whose chroma leaves the gamut or whose contrast falls
 * under 4.5:1, so a bad hue cannot reach an operator's screen.
 */

// --- The palette this all rotates around ------------------------------------

/** A colour in OKLCH, as `app/globals.css` writes them. */
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  /** 0–1. Present only for the ring tokens, which are the dye at low alpha. */
  readonly alpha?: number;
  /**
   * False for the one role whose hue belongs to the CLOTH, not to the dye:
   * the ink that stands on a dye-coloured surface is the muslin of the card,
   * and rotating it would tint the label on every primary button.
   */
  readonly rotates: boolean;
}

/** The five distinct colours the dye family is made of, per scheme. */
interface DyeRoles {
  /** The action colour itself. */
  readonly dye: OklchColor;
  /** The ink that stands ON the dye. */
  readonly dyeInk: OklchColor;
  /** The "đang chọn" tint — a selected row, a checked control. */
  readonly wash: OklchColor;
  /** The ink that stands on that tint. */
  readonly washInk: OklchColor;
  /** Focus ring: the dye at low alpha. */
  readonly dyeRing: OklchColor;
}

/** Light scheme, copied from `:root` in `app/globals.css`. */
const LIGHT_ROLES: DyeRoles = {
  dye: { l: 0.45, c: 0.105, h: 262, rotates: true },
  dyeInk: { l: 0.984, c: 0.007, h: 84, rotates: false },
  wash: { l: 0.89, c: 0.045, h: 262, rotates: true },
  washInk: { l: 0.38, c: 0.11, h: 263, rotates: true },
  dyeRing: { l: 0.45, c: 0.105, h: 262, alpha: 0.45, rotates: true },
};

/**
 * Dark scheme, copied from `.dark`. `dyeInk` DOES rotate here: on dark cloth
 * the ink on a primary button is a very dark tint of the dye itself, not the
 * muslin — so leaving it at 262 would put an indigo label on a plum button.
 */
const DARK_ROLES: DyeRoles = {
  dye: { l: 0.68, c: 0.09, h: 262, rotates: true },
  dyeInk: { l: 0.22, c: 0.03, h: 262, rotates: true },
  wash: { l: 0.36, c: 0.075, h: 262, rotates: true },
  washInk: { l: 0.86, c: 0.06, h: 262, rotates: true },
  dyeRing: { l: 0.68, c: 0.09, h: 262, alpha: 0.5, rotates: true },
};

/**
 * Every CSS variable cut from the dye, and which role it wears. Both schemes
 * use this same map — `.dark` re-values the roles, it does not re-assign them.
 *
 * `--chart-2..5` are deliberately ABSENT: those are the status hues (fact,
 * good, attention, failure), and a status colour that follows the brand stops
 * meaning what it says. `--chart-1` is in, because it IS the action colour.
 */
const TOKEN_ROLES = {
  "--primary": "dye",
  "--primary-foreground": "dyeInk",
  "--accent": "wash",
  "--accent-foreground": "washInk",
  "--ring": "dyeRing",
  "--chart-1": "dye",
  "--sidebar-primary": "dye",
  "--sidebar-primary-foreground": "dyeInk",
  "--sidebar-accent": "wash",
  "--sidebar-accent-foreground": "washInk",
  "--sidebar-ring": "dyeRing",
} as const satisfies Record<string, keyof DyeRoles>;

export type AppearanceTokenName = keyof typeof TOKEN_ROLES;

/** The token names, in the order the generated CSS prints them. */
export const APPEARANCE_TOKEN_NAMES = Object.keys(TOKEN_ROLES) as readonly AppearanceTokenName[];

// --- The presets ------------------------------------------------------------

export interface AppearancePreset {
  readonly id: string;
  /** What the swatch is called on screen. */
  readonly label: string;
  /** One line under the label — what it looks like, not what it is for. */
  readonly description: string;
  /** OKLCH hue of the dye, 0–359. */
  readonly hue: number;
  /**
   * Fraction of the base chroma this hue can hold inside sRGB, 0–1. Measured
   * per hue; see the file header. 1 = the full chroma of the original palette.
   */
  readonly chromaScale: number;
}

/**
 * Six presets, spread far enough apart that nobody has to compare two swatches
 * side by side to tell them apart. `cham` is the original and reproduces
 * `globals.css` value for value — so "hoàn nguyên" is a real return, not an
 * approximation of one.
 *
 * NO RED PRESET, on purpose: `--destructive` is madder at hue 30, and an action
 * colour a few degrees away from the delete colour is the one confusion this
 * palette must never sell. The warm slot is `ca-phe`, far enough down in chroma
 * to read as brown rather than as a dulled red.
 */
export const APPEARANCE_PRESETS = [
  {
    id: "cham",
    label: "Chàm",
    description: "Bản gốc của sổ mẫu vải — chàm nhuộm, trầm và lạnh.",
    hue: 262,
    chromaScale: 1,
  },
  {
    id: "ngoc-luc",
    label: "Ngọc lục",
    description: "Xanh ngọc trầm, mát nhất trong bộ.",
    hue: 190,
    chromaScale: 0.6,
  },
  {
    id: "reu",
    label: "Rêu",
    description: "Xanh lá ngả rêu, ấm và tĩnh.",
    hue: 145,
    chromaScale: 1,
  },
  {
    id: "ca-phe",
    label: "Cà phê",
    description: "Nâu cà phê, gần như hoà vào nền vải mộc.",
    hue: 60,
    chromaScale: 0.8,
  },
  {
    id: "tia",
    label: "Tía",
    description: "Tím tía, đậm và trang trọng.",
    hue: 300,
    chromaScale: 1,
  },
  {
    id: "man",
    label: "Mận",
    description: "Đỏ mận ngả hồng, ấm nhất trong bộ.",
    hue: 335,
    chromaScale: 1,
  },
] as const satisfies readonly AppearancePreset[];

export type AppearancePresetId = (typeof APPEARANCE_PRESETS)[number]["id"];

/**
 * What the app wears when nobody has chosen anything — and what "hoàn nguyên"
 * returns to. It is the approved direction, so an empty settings table and a
 * fresh install look exactly like the design that was signed off.
 */
export const DEFAULT_APPEARANCE_PRESET_ID: AppearancePresetId = "cham";

export const APPEARANCE_PRESET_IDS = APPEARANCE_PRESETS.map(
  (preset) => preset.id,
) as readonly AppearancePresetId[];

/** Guard for anything arriving from outside: a request body, a database row. */
export function isAppearancePresetId(value: unknown): value is AppearancePresetId {
  return (
    typeof value === "string" &&
    APPEARANCE_PRESETS.some((preset) => preset.id === (value as AppearancePresetId))
  );
}

/** The row for an id. Throws for an unknown id — callers guard first. */
export function findAppearancePreset(id: AppearancePresetId): AppearancePreset {
  const preset = APPEARANCE_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown appearance preset: ${id}`);
  }
  return preset;
}

// --- Deriving the tokens ----------------------------------------------------

/** Trims float noise (0.105 * 0.6 = 0.06300000000000001) without lying. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Applies a preset to one role. Untouched roles come back verbatim. */
function applyPreset(color: OklchColor, preset: AppearancePreset): OklchColor {
  if (!color.rotates) return color;
  // The dye's own hue is 262; a role sitting a degree off (washInk at 263)
  // keeps that offset, so `cham` round-trips to the original values exactly.
  const hue = (((color.h - LIGHT_ROLES.dye.h + preset.hue) % 360) + 360) % 360;
  return { ...color, h: hue, c: round(color.c * preset.chromaScale, 4) };
}

/** The CSS value, in the same notation `globals.css` uses. */
export function formatOklch(color: OklchColor): string {
  const base = `${color.l} ${color.c} ${color.h}`;
  if (color.alpha === undefined) return `oklch(${base})`;
  return `oklch(${base} / ${round(color.alpha * 100, 2)}%)`;
}

export type AppearanceScheme = "light" | "dark";

/**
 * Every token a preset sets, for one scheme. Values are CSS strings, ready to
 * be written into a stylesheet or handed to a `style` attribute for a preview.
 */
export function derivePresetTokens(
  preset: AppearancePreset,
  scheme: AppearanceScheme,
): Record<AppearanceTokenName, string> {
  const roles = scheme === "light" ? LIGHT_ROLES : DARK_ROLES;
  const tokens = {} as Record<AppearanceTokenName, string>;

  for (const name of APPEARANCE_TOKEN_NAMES) {
    tokens[name] = formatOklch(applyPreset(roles[TOKEN_ROLES[name]], preset));
  }

  return tokens;
}

/**
 * The raw colours behind `derivePresetTokens`, for the contrast test and for
 * the swatch the settings screen draws. Kept separate so nothing has to parse
 * a CSS string back into numbers.
 */
export function derivePresetColors(
  preset: AppearancePreset,
  scheme: AppearanceScheme,
): Record<keyof DyeRoles, OklchColor> {
  const roles = scheme === "light" ? LIGHT_ROLES : DARK_ROLES;
  return {
    dye: applyPreset(roles.dye, preset),
    dyeInk: applyPreset(roles.dyeInk, preset),
    wash: applyPreset(roles.wash, preset),
    washInk: applyPreset(roles.washInk, preset),
    dyeRing: applyPreset(roles.dyeRing, preset),
  };
}

/**
 * The two surfaces a dye has to stand on, unchanged by any preset — the cloth
 * ground and the swatch card. Exported so the contrast test measures against
 * the real palette rather than a copy of it.
 */
export const APPEARANCE_SURFACES: Record<AppearanceScheme, { ground: OklchColor; card: OklchColor }> =
  {
    light: {
      ground: { l: 0.955, c: 0.013, h: 84, rotates: false },
      card: { l: 0.984, c: 0.007, h: 84, rotates: false },
    },
    dark: {
      ground: { l: 0.24, c: 0.012, h: 60, rotates: false },
      card: { l: 0.28, c: 0.014, h: 60, rotates: false },
    },
  };

/** The attribute the root element carries. One place, three readers. */
export const APPEARANCE_PRESET_ATTRIBUTE = "data-theme-preset";
