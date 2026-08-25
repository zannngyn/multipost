/**
 * The colour presets an MYSP platform admin may put on the whole app.
 *
 * A preset repaints the WHOLE surface — ground, cards, sunken panels, hairlines
 * and ink — not just the action colour. What it never touches is LIGHTNESS.
 * Every token keeps the exact lightness `app/globals.css` gave it, and
 * lightness is what carries contrast, so a preset cannot turn a readable screen
 * into an unreadable one. That is the whole safety argument for letting a
 * non-designer repaint the product from a settings screen, and it is CHECKED,
 * not asserted: `appearance-presets.test.ts` measures every text/surface pair
 * in both schemes and pins the lightness of every role.
 *
 * TWO KNOBS, NOT ONE. The dye (action colour) and the cloth (everything else)
 * move independently:
 *   - `hue` + `chromaScale` rotate the dye;
 *   - `groundShift` + `surfaceChromaScale` / `inkChromaScale` tint the cloth.
 * Surfaces take the tint strongly — that is what makes a preset read as a
 * theme rather than as a button colour. Ink takes it faintly: text that is as
 * saturated as the paper stops reading as ink.
 *
 * CHROMA IS CLAMPED PER TOKEN, NOT SCALED BLINDLY. sRGB holds far less chroma
 * at L 0.984 (a card, nearly white) than at L 0.53, and it holds different
 * amounts at different hues. A value outside the gamut is silently clipped by
 * the browser — and clipping MOVES LIGHTNESS, which would void the argument
 * above. So each token asks for `base × scale` and gets whatever the gamut can
 * actually hold. That is why a card stays paler than the ground it sits on: it
 * is not a compromise, it is the only honest value.
 *
 * `cham` IS THE ORIGINAL. Its shifts are zero and its scales are one, so it
 * reproduces `globals.css` value for value — "hoàn nguyên" is a real return,
 * not an approximation of one. It is the only preset that keeps the warm
 * unbleached-muslin ground; every other one tints the cloth toward its own dye.
 *
 * WHY IT LIVES IN `shared/`: the CSS generator (a script), the usecase that
 * validates what is stored (core) and the screen that draws the swatches (ui)
 * all need the SAME list, and `ui` may import nothing but `@/shared` and
 * `@/ui` (eslint.config.mjs). One table, three readers.
 *
 * ADDING A PRESET: add the row, run `pnpm run theme:presets`, run the tests.
 * The test refuses a row whose contrast falls under 4.5:1 or whose lightness
 * moved, so a bad hue cannot reach an operator's screen.
 */

// --- Colour primitives ------------------------------------------------------

/** A colour in OKLCH, as `app/globals.css` writes them. */
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  /** 0–1. Present only where the palette uses a translucent value. */
  readonly alpha?: number;
}

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

/** Half a 16-bit step of slack, so an exact-boundary colour is not "outside". */
const GAMUT_EPSILON = 0.0005;

export function isInSrgbGamut(color: OklchColor): boolean {
  return toLinearSrgb(color).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
  );
}

/**
 * The most chroma this lightness and hue can hold in sRGB, with 2% headroom.
 *
 * Binary search rather than a table: the gamut boundary is a different curve
 * for every hue, and a table would be a second set of numbers to keep true.
 */
function maxChromaFor(l: number, h: number): number {
  let low = 0;
  let high = 0.4;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (isInSrgbGamut({ l, c: mid, h })) low = mid;
    else high = mid;
  }
  return Math.floor(low * 0.98 * 1e4) / 1e4;
}

/** Trims float noise (0.02 * 1.5 = 0.030000000000000002) without lying. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// --- The palette a preset rotates -------------------------------------------

/**
 * Every role the palette is cut from, per scheme. Two families:
 *
 *  - the DYE: the action colour and what stands on it;
 *  - the CLOTH: the ground, the surfaces above it, and the ink on them.
 *
 * Values copied from `:root` and `.dark` in `app/globals.css`.
 */
interface PaletteRoles {
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

  /** The page itself — the largest area a preset repaints. */
  readonly ground: OklchColor;
  /** One step above the ground: card, popover, dialog, sidebar. */
  readonly card: OklchColor;
  /** One step below: a sunken panel, a segmented control's trough. */
  readonly sunken: OklchColor;
  /** Stand-in surface for media we cannot show. */
  readonly mediaEmpty: OklchColor;
  readonly mediaCover: OklchColor;
  /** Body copy and headings. */
  readonly ink: OklchColor;
  /** Supporting lines and descriptions. */
  readonly inkMuted: OklchColor;
  /** The third tone: eyebrows, mono metadata. The tightest ratio in the set. */
  readonly inkSubtle: OklchColor;
  /**
   * A panel that stands OFF the page: the ink used as a surface in the light
   * scheme, and — since there is nothing left to invert on dark cloth — an
   * elevated surface in the dark one. Same role, both schemes.
   */
  readonly inverseSurface: OklchColor;
  /** The text that stands on it. */
  readonly inverseForeground: OklchColor;
  /** Hairline borders — the ink at low alpha, never a grey. */
  readonly hairline: OklchColor;
  /** The slightly stronger hairline an input wears. */
  readonly inputLine: OklchColor;
}

const LIGHT_ROLES: PaletteRoles = {
  dye: { l: 0.45, c: 0.105, h: 262 },
  // The one role whose hue belongs to the CLOTH, not the dye: the ink standing
  // on a dye-coloured surface IS the card. Tied to `card` below, not rotated
  // with the dye — rotating it would tint the label on every primary button.
  dyeInk: { l: 0.984, c: 0.007, h: 84 },
  wash: { l: 0.89, c: 0.045, h: 262 },
  washInk: { l: 0.38, c: 0.11, h: 263 },
  dyeRing: { l: 0.45, c: 0.105, h: 262, alpha: 0.45 },

  ground: { l: 0.955, c: 0.013, h: 84 },
  card: { l: 0.984, c: 0.007, h: 84 },
  sunken: { l: 0.933, c: 0.014, h: 84 },
  mediaEmpty: { l: 0.92, c: 0.02, h: 84 },
  mediaCover: { l: 0.9, c: 0.025, h: 80 },
  ink: { l: 0.28, c: 0.018, h: 55 },
  inkMuted: { l: 0.47, c: 0.02, h: 58 },
  inkSubtle: { l: 0.53, c: 0.02, h: 60 },
  inverseSurface: { l: 0.28, c: 0.018, h: 55 },
  inverseForeground: { l: 0.955, c: 0.013, h: 84 },
  hairline: { l: 0.28, c: 0.018, h: 55, alpha: 0.12 },
  inputLine: { l: 0.28, c: 0.018, h: 55, alpha: 0.16 },
};

/**
 * The dark scheme. `dyeInk` DOES follow the dye here: on dark cloth the ink on
 * a primary button is a very dark tint of the dye itself, not the muslin — so
 * leaving it behind would put an indigo label on a plum button.
 *
 * The hairlines are white-at-alpha rather than ink-at-alpha (shadows are
 * invisible on a dark ground, so elevation comes from a lighter edge). Chroma 0
 * means a rotation is a no-op on them, which is correct: a tinted hairline on
 * dark cloth reads as a colour fringe.
 */
const DARK_ROLES: PaletteRoles = {
  dye: { l: 0.68, c: 0.09, h: 262 },
  dyeInk: { l: 0.22, c: 0.03, h: 262 },
  wash: { l: 0.36, c: 0.075, h: 262 },
  washInk: { l: 0.86, c: 0.06, h: 262 },
  dyeRing: { l: 0.68, c: 0.09, h: 262, alpha: 0.5 },

  ground: { l: 0.24, c: 0.012, h: 60 },
  card: { l: 0.28, c: 0.014, h: 60 },
  sunken: { l: 0.32, c: 0.014, h: 60 },
  mediaEmpty: { l: 0.33, c: 0.018, h: 60 },
  mediaCover: { l: 0.36, c: 0.022, h: 75 },
  ink: { l: 0.94, c: 0.01, h: 84 },
  inkMuted: { l: 0.72, c: 0.016, h: 65 },
  inkSubtle: { l: 0.66, c: 0.018, h: 60 },
  inverseSurface: { l: 0.38, c: 0.016, h: 60 },
  inverseForeground: { l: 0.96, c: 0.01, h: 84 },
  hairline: { l: 1, c: 0, h: 0, alpha: 0.12 },
  inputLine: { l: 1, c: 0, h: 0, alpha: 0.16 },
};

export type PaletteRole = keyof PaletteRoles;

/** Which family a role belongs to — it decides which knob moves it. */
const DYE_ROLES: readonly PaletteRole[] = ["dye", "wash", "washInk", "dyeRing"];
const SURFACE_ROLES: readonly PaletteRole[] = [
  "ground",
  "card",
  "sunken",
  "mediaEmpty",
  "mediaCover",
  "inverseSurface",
];
const INK_ROLES: readonly PaletteRole[] = [
  "ink",
  "inkMuted",
  "inkSubtle",
  "inverseForeground",
  "hairline",
  "inputLine",
];

/**
 * Every CSS variable the palette owns, and which role it wears. Both schemes
 * use this same map — `.dark` re-values the roles, it does not re-assign them.
 *
 * `--chart-2..5` are deliberately ABSENT, and so are `--destructive`,
 * `--warning`, `--success` and `--info`: those are the status hues, and a
 * status colour that follows the brand stops meaning what it says. `--chart-1`
 * is in, because it IS the action colour.
 */
const TOKEN_ROLES = {
  // The dye
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

  // The cloth — surfaces
  "--background": "ground",
  "--card": "card",
  "--popover": "card",
  "--sidebar": "card",
  "--secondary": "sunken",
  "--muted": "sunken",
  "--media-empty": "mediaEmpty",
  "--media-empty-cover": "mediaCover",
  "--inverse-surface": "inverseSurface",

  // The cloth — ink and hairlines
  "--foreground": "ink",
  "--card-foreground": "ink",
  "--popover-foreground": "ink",
  "--secondary-foreground": "ink",
  "--sidebar-foreground": "ink",
  "--muted-foreground": "inkMuted",
  "--foreground-subtle": "inkSubtle",
  "--inverse-foreground": "inverseForeground",
  "--border": "hairline",
  "--input": "inputLine",
  "--sidebar-border": "hairline",
} as const satisfies Record<string, PaletteRole>;

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
  /** Fraction of the base dye chroma this hue can hold inside sRGB, 0–1. */
  readonly chromaScale: number;
  /**
   * Degrees added to every CLOTH hue. Chosen so the light ground lands on the
   * dye's hue — the cloth and the dye come from one family. Zero for `cham`,
   * which keeps the warm unbleached muslin of the approved design.
   */
  readonly groundShift: number;
  /** Multiplier on surface chroma. The tint you actually see. */
  readonly surfaceChromaScale: number;
  /** Multiplier on ink chroma. Deliberately far lower — ink stays ink. */
  readonly inkChromaScale: number;
}

/**
 * Six presets, spread far enough apart that nobody has to compare two swatches
 * side by side to tell them apart.
 *
 * NO RED PRESET, on purpose: `--destructive` is madder at hue 30, and an action
 * colour a few degrees from the delete colour is the one confusion this palette
 * must never sell. The warm slot is `ca-phe`.
 *
 * `son-mai` IS THE ONE EXCEPTION TO THAT RULE, and it was asked for explicitly:
 * its gold is the hue `--warning` already occupies. The separation was measured
 * rather than hoped for. In OKLab distance the action colour sits 0.312 from
 * the warning colour in the light scheme — the same room the shipped `ca-phe`
 * has (0.313), and not far off indigo's 0.383. In the DARK scheme it is only
 * 0.123, because both are light golds there and only lightness separates them.
 * For scale: `globals.css` records 0.084 as too close ("hai cái pill cách màn
 * hình một mét trông như một màu") and moved dark `--info` to fix it. 0.123 is
 * comfortably better than the case that was rejected and clearly worse than the
 * rest of this table, so: a gold "Lưu" button and a gold "cảnh báo" badge on one
 * dark screen will read as related. Hue does not fix it — sweeping 70°–100°
 * moves the distance by 0.007 — only lightness would, and lightness is frozen.
 */
export const APPEARANCE_PRESETS = [
  {
    id: "cham",
    label: "Chàm",
    description: "Bản gốc của sổ mẫu vải — nền vải mộc ấm, chàm nhuộm trầm và lạnh.",
    hue: 262,
    chromaScale: 1,
    groundShift: 0,
    surfaceChromaScale: 1,
    inkChromaScale: 1,
  },
  {
    id: "son-mai",
    label: "Sơn mài",
    description: "Nền than ấm, nhấn vàng nghệ — tông của thẻ thiết lập, trải ra cả sản phẩm.",
    // Turmeric, the hue the setup dock already wears. It sits close to
    // `--warning`, which is the same gold — see the note below the table.
    hue: 85,
    chromaScale: 1,
    groundShift: 1,
    // Lower than the other presets on purpose: lacquer is black and gold, so
    // the cloth stays near-neutral (warm ivory in light, warm charcoal in dark)
    // and the gold does all the talking. A tinted ground would fight it.
    surfaceChromaScale: 2.5,
    inkChromaScale: 1.5,
  },
  {
    id: "ngoc-luc",
    label: "Ngọc lục",
    description: "Nền ngả xanh ngọc, mực cùng tông — mát nhất trong bộ.",
    hue: 190,
    chromaScale: 0.6,
    groundShift: 106,
    surfaceChromaScale: 4,
    inkChromaScale: 1.5,
  },
  {
    id: "reu",
    label: "Rêu",
    description: "Nền xanh lá ngả rêu, ấm và tĩnh.",
    hue: 145,
    chromaScale: 1,
    groundShift: 61,
    surfaceChromaScale: 4,
    inkChromaScale: 1.5,
  },
  {
    id: "ca-phe",
    label: "Cà phê",
    description: "Nền giấy nâu, mực cà phê — trầm và ấm nhất.",
    hue: 60,
    chromaScale: 0.8,
    groundShift: -24,
    surfaceChromaScale: 4,
    inkChromaScale: 1.5,
  },
  {
    id: "tia",
    label: "Tía",
    description: "Nền ngả tím nhạt, tím tía đậm cho hành động.",
    hue: 300,
    chromaScale: 1,
    groundShift: 216,
    surfaceChromaScale: 4,
    inkChromaScale: 1.5,
  },
  {
    id: "man",
    label: "Mận",
    description: "Nền ngả hồng, đỏ mận cho hành động — ấm và tươi.",
    hue: 335,
    chromaScale: 1,
    groundShift: 251,
    surfaceChromaScale: 4,
    inkChromaScale: 1.5,
  },
] as const satisfies readonly AppearancePreset[];

export type AppearancePresetId = (typeof APPEARANCE_PRESETS)[number]["id"];

/**
 * What the app wears when nobody has chosen anything — and what "hoàn nguyên"
 * returns to.
 *
 * `son-mai`, not `cham`: the tone of the setup dock — warm charcoal and gold —
 * was asked for as the tone of the whole product, and a default nobody has to
 * go and select is the only way "cả hệ thống" is actually true on a fresh
 * install.
 *
 * `cham` stays in the table and stays the REFERENCE: it is the only preset
 * that reproduces `globals.css` value for value, which is what the tests
 * measure everything else against. Reference and default are two different
 * jobs, and this is the one line that decides the second.
 */
export const DEFAULT_APPEARANCE_PRESET_ID: AppearancePresetId = "son-mai";

/**
 * The preset that reproduces the approved "Sổ mẫu vải" palette exactly. Used
 * by the tests as the baseline every other preset is compared against — never
 * as "what the app looks like".
 */
export const REFERENCE_APPEARANCE_PRESET_ID: AppearancePresetId = "cham";

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

/**
 * The dye's own hue in the original palette. Roles sitting a degree off it
 * (washInk at 263) keep that offset when a preset rotates the family, so `cham`
 * round-trips to the shipped values exactly.
 *
 * The cloth needs no anchor: `groundShift` is already a delta.
 */
const DYE_ANCHOR_HUE = LIGHT_ROLES.dye.h;

function rotate(hue: number, by: number): number {
  return (((hue + by) % 360) + 360) % 360;
}

/**
 * Applies a preset to one role.
 *
 * The requested chroma is clamped to what sRGB can hold at that lightness and
 * hue — see the file header. Lightness and alpha are never touched.
 */
function applyPreset(role: PaletteRole, color: OklchColor, preset: AppearancePreset): OklchColor {
  let hue = color.h;
  let scale = 1;

  if (DYE_ROLES.includes(role)) {
    // A role sitting a degree off the anchor (washInk at 263) keeps that
    // offset, so `cham` round-trips to the original values exactly.
    hue = rotate(color.h - DYE_ANCHOR_HUE + preset.hue, 0);
    scale = preset.chromaScale;
  } else if (SURFACE_ROLES.includes(role)) {
    hue = rotate(color.h, preset.groundShift);
    scale = preset.surfaceChromaScale;
  } else if (INK_ROLES.includes(role)) {
    hue = rotate(color.h, preset.groundShift);
    scale = preset.inkChromaScale;
  } else {
    // `dyeInk` in the light scheme: it is the CARD, so it moves with the cloth
    // and must stay identical to `--card` or the label on a primary button
    // stops matching the paper it was cut from.
    hue = rotate(color.h, preset.groundShift);
    scale = preset.surfaceChromaScale;
  }

  const wanted = color.c * scale;
  const chroma = round(Math.min(wanted, maxChromaFor(color.l, hue)), 4);

  return { l: color.l, c: chroma, h: hue, ...(color.alpha === undefined ? {} : { alpha: color.alpha }) };
}

/**
 * In the DARK scheme `dyeInk` belongs to the dye, not the cloth (see
 * DARK_ROLES). Handled here rather than by another table so the role list stays
 * one list.
 */
function roleFamilyFor(role: PaletteRole, scheme: AppearanceScheme): PaletteRole {
  if (role === "dyeInk" && scheme === "dark") return "dye";
  return role;
}

/** The CSS value, in the same notation `globals.css` uses. */
export function formatOklch(color: OklchColor): string {
  const base = `${color.l} ${color.c} ${color.h}`;
  if (color.alpha === undefined) return `oklch(${base})`;
  return `oklch(${base} / ${round(color.alpha * 100, 2)}%)`;
}

export type AppearanceScheme = "light" | "dark";

/** Every role of one scheme, with the preset applied. */
export function derivePresetColors(
  preset: AppearancePreset,
  scheme: AppearanceScheme,
): Record<PaletteRole, OklchColor> {
  const roles = scheme === "light" ? LIGHT_ROLES : DARK_ROLES;
  const out = {} as Record<PaletteRole, OklchColor>;

  for (const role of Object.keys(roles) as PaletteRole[]) {
    out[role] = applyPreset(roleFamilyFor(role, scheme), roles[role], preset);
  }

  return out;
}

/**
 * Every token a preset sets, for one scheme. Values are CSS strings, ready to
 * be written into a stylesheet.
 */
export function derivePresetTokens(
  preset: AppearancePreset,
  scheme: AppearanceScheme,
): Record<AppearanceTokenName, string> {
  const colors = derivePresetColors(preset, scheme);
  const tokens = {} as Record<AppearanceTokenName, string>;

  for (const name of APPEARANCE_TOKEN_NAMES) {
    tokens[name] = formatOklch(colors[TOKEN_ROLES[name]]);
  }

  return tokens;
}

/** The attribute the root element carries. One place, three readers. */
export const APPEARANCE_PRESET_ATTRIBUTE = "data-theme-preset";
