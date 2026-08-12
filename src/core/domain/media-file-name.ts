/**
 * Drive file-name parser + colour vocabulary (E2).
 * Pure TypeScript: no imports, no I/O (docs/07 section 2).
 *
 * The brief (section 2.1) assumes every file is `CODE-Colour (n).ext`. The real
 * folder is not: docs/05 section 1.2 measured 28.2% of 5,497 files off-standard
 * (no sequence number, no extension, leading tabs, `-AI` suffixes, two codes
 * glued together...). Rejecting all of them would make the tool useless, so the
 * parser works in two tiers:
 *
 *   tier 1 (strict)  — exactly `CODE-Colour (n).ext`, canonical colour, known
 *                      extension. `isStrict: true` on the result.
 *   tier 2 (lenient) — trims whitespace, accepts a missing sequence / missing or
 *                      dotless extension, splits off `-AI` / `-THỰC TẾ` /
 *                      `-MẶT SAU` markers, maps colour aliases. Every deviation
 *                      is recorded as a warning, never swallowed.
 *
 * A name that still cannot be understood returns `{ ok: false, issue, raw }` —
 * a value, not a throw: one bad file must never abort a 5,000-file sync
 * (CLAUDE.md business rule 5).
 */

// --- Media kind -------------------------------------------------------------

export const MEDIA_KINDS = ["image", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Extensions accepted by the brief (section 2.1) + `.mov` found in real data. */
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "mov"] as const;
const KNOWN_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

// --- Result shape -----------------------------------------------------------

/** Hard failures: the file cannot be attached to a product with confidence. */
export const MEDIA_NAME_ISSUES = [
  /** Empty / whitespace-only name. */
  "EMPTY_NAME",
  /** No product code at the start of the name (`IMG_1664.JPG`, `1.jpg`). */
  "NO_PRODUCT_CODE",
] as const;
export type MediaNameIssue = (typeof MEDIA_NAME_ISSUES)[number];

/** Soft deviations: the file is usable but an operator should see the list. */
export const MEDIA_NAME_WARNINGS = [
  "LEADING_TRAILING_WHITESPACE",
  "MISSING_SEQUENCE",
  "MISSING_EXTENSION",
  "UNKNOWN_EXTENSION",
  "EXTENSION_WITHOUT_DOT",
  "MISSING_COLOR",
  "UNKNOWN_COLOR",
  "EXTRA_TOKENS",
  /** Same code written twice (`MG0AD6112-KEMMG0AD6112-AI`). */
  "REPEATED_PRODUCT_CODE",
  /** Several codes in one name (`MG0AD6051-MR0CV6068-AI`) — outfit sets. */
  "MULTIPLE_PRODUCT_CODES",
] as const;
export type MediaNameWarning = (typeof MEDIA_NAME_WARNINGS)[number];

/** Suffixes carried by the file name, kept apart from the colour on purpose. */
export interface MediaVariantFlags {
  /** `-AI` — AI-generated render. */
  readonly aiGenerated: boolean;
  /** `-THỰC TẾ` — real photo shoot. */
  readonly realPhoto: boolean;
  /** `-SAU` / `-MẶT SAU` — back of the garment. */
  readonly backView: boolean;
}

export interface MediaFileName {
  readonly raw: string;
  /** Whitespace-normalised name (what the warnings refer to). */
  readonly normalized: string;
  readonly productCode: string;
  /**
   * Other codes found in the same name (outfit sets, 739 real files). The asset
   * is attributed to `productCode` — the one opening the name — and flagged.
   */
  readonly otherProductCodes: readonly string[];
  /** Canonical colour (`XANH THAN`), or null when the name carries none. */
  readonly color: string | null;
  /** Colour exactly as written in the file name; null when there is none. */
  readonly colorRaw: string | null;
  /** The `(n)` suffix. Null for the 1,063 files that have none (docs/05 1.2). */
  readonly sequence: number | null;
  /** Lower-case, no dot. Null when the file has no extension (606 real files). */
  readonly extension: string | null;
  readonly kind: MediaKind;
  readonly variants: MediaVariantFlags;
  /** Leftover segments: model names, foreign product names, stray numbers. */
  readonly extraTokens: readonly string[];
  readonly warnings: readonly MediaNameWarning[];
  /** True only for tier 1 — used to report naming compliance to operators. */
  readonly isStrict: boolean;
}

export type ParsedMediaFileName =
  | { readonly ok: true; readonly value: MediaFileName }
  | {
      readonly ok: false;
      readonly issue: MediaNameIssue;
      readonly raw: string;
      readonly normalized: string;
      /** Human-readable detail for the "skipped files" screen. English. */
      readonly detail: string;
    };

// --- Colour vocabulary ------------------------------------------------------

/**
 * Canonical colours seen in the Sheet `Màu sắc` column and in file names
 * (docs/05 sections 1.3 + 2.4). Diacritics kept: this is what operators read.
 *
 * PENDING(C3)/PENDING(C4): shades are NOT merged — `XANH` and `XANH NHẠT` stay
 * two colours, so a "XANH" post cannot silently pull light-blue photos. If the
 * stakeholder decides shades should be grouped, add the grouping here, not in
 * the album builder.
 */
export const CANONICAL_COLORS = [
  "TRẮNG",
  "TRẮNG KEM",
  "TRẮNG TIÊU",
  "KEM",
  "KEM NÂU",
  "XANH",
  "XANH NHẠT",
  "XANH ĐẬM",
  "XANH THAN",
  "XANH DƯƠNG",
  "XANH GHI",
  "XANH XÁM",
  "XANH BE",
  "XANH RÊU",
  "XANH LÁ",
  "HỒNG",
  "HỒNG TÍM",
  "HỒNG CAM",
  "HỒNG KEM",
  "HỒNG NUDE",
  "NÂU",
  "NÂU VÀNG",
  "NÂU BE",
  "NÂU RÊU",
  "NÂU HỒNG",
  "ĐỎ",
  "ĐEN",
  "ĐEN XÁM",
  "VÀNG",
  "VÀNG NHẠT",
  "BE",
  "BE CAM",
  "XÁM",
  "XÁM ĐẬM",
  "TÍM",
  "CAM",
  "GHI",
  "NUDE",
  "CỐM",
  "TIÊU",
] as const;

/**
 * Comparison key: casefold + strip diacritics + drop everything that is not a
 * letter/digit. `TRANG`, `Trắng`, ` trắng ` and `TRẮNG` all collapse to `TRANG`;
 * `XANHTHAN` collapses to the same key as `XANH THAN` (docs/05 section 1.3).
 */
export function colorKey(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** key -> canonical colour. Built once from CANONICAL_COLORS. */
const COLOR_BY_KEY: ReadonlyMap<string, string> = new Map(
  CANONICAL_COLORS.map((color) => [colorKey(color), color]),
);

/**
 * Extra spellings that do not collapse onto a canonical colour by themselves.
 * Keep this list short and evidence-based — every entry must come from a real
 * file name, never from a guess. `OD` (14 files) is deliberately absent: it may
 * be a typo of `ĐỎ` or an unrelated marker, and guessing would mislabel photos.
 */
const COLOR_ALIASES: ReadonlyMap<string, string> = new Map([
  ["XANHNHAT", "XANH NHẠT"],
  ["XANHDUONG", "XANH DƯƠNG"],
  ["HONGTIM", "HỒNG TÍM"],
  ["HONGKEM", "HỒNG KEM"],
  ["NAUBE", "NÂU BE"],
  ["NAUHONG", "NÂU HỒNG"],
  ["BECAM", "BE CAM"],
]);

/** Canonical colour for any spelling, or null when it is not a known colour. */
export function normalizeColorName(raw: string): string | null {
  const key = colorKey(raw);
  if (key.length === 0) return null;
  return COLOR_BY_KEY.get(key) ?? COLOR_ALIASES.get(key) ?? null;
}

/** True when two colour spellings mean the same colour (`NAU` === `NÂU`). */
export function isSameColor(a: string, b: string): boolean {
  const canonicalA = normalizeColorName(a);
  const canonicalB = normalizeColorName(b);
  if (canonicalA && canonicalB) return canonicalA === canonicalB;
  return colorKey(a) === colorKey(b) && colorKey(a).length > 0;
}

// --- Product code -----------------------------------------------------------

/**
 * Shape observed in both sources: 2 brand letters, an optional line character,
 * 2 category letters, 3-4 digits (`MMAC546`, `MG0AD6112`, `MRKVX6371`).
 * Verified against all 299 sheet codes (docs/05 section 2.1).
 */
const PRODUCT_CODE_PATTERN = /[A-Z]{2}[A-Z0-9]?[A-Z]{2}\d{3,4}/g;

export function isProductCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const upper = value.trim().toUpperCase();
  const match = new RegExp(`^${PRODUCT_CODE_PATTERN.source}$`).exec(upper);
  return match !== null;
}

/** Upper-cases and trims a code so Sheet and Drive spellings meet (`Mrkvx6330`). */
export function normalizeProductCode(value: string): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

// --- Variant markers --------------------------------------------------------

const AI_KEYS = new Set(["AI", "AICOPY", "AIC"]);
const REAL_PHOTO_KEYS = new Set(["THUCTE", "ANHTHUCTE", "THUCTE1"]);
const BACK_VIEW_KEYS = new Set(["SAU", "MATSAU", "MATSAUC"]);

function classifyMarker(key: string): keyof MediaVariantFlags | null {
  if (AI_KEYS.has(key)) return "aiGenerated";
  if (REAL_PHOTO_KEYS.has(key)) return "realPhoto";
  if (BACK_VIEW_KEYS.has(key)) return "backView";
  return null;
}

// --- Parser -----------------------------------------------------------------

/** Whitespace/tab normalisation. Real names start with `   \t ` (97 files). */
function normalizeWhitespace(raw: string): string {
  return raw.normalize("NFC").replace(/[\s\u00a0]+/g, " ").trim();
}

interface ExtensionSplit {
  base: string;
  extension: string | null;
  warning: MediaNameWarning | null;
}

function splitExtension(name: string): ExtensionSplit {
  // 1. Standard `.ext`.
  const dotted = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (dotted) {
    const ext = dotted[1].toLowerCase();
    const base = name.slice(0, dotted.index).trim();
    if (KNOWN_EXTENSIONS.includes(ext)) return { base, extension: ext, warning: null };
    // `.heic` (31 files), `.2025` (a date mistaken for an extension) — strip it
    // so the code/colour still parse, but flag the file for confirmation.
    return { base, extension: ext, warning: "UNKNOWN_EXTENSION" };
  }

  // 2. Dotless extension: `MMAD538JPG`, `MG0AD6021-AI (10) mp4`.
  const glued = new RegExp(`(?:\\s|)(${KNOWN_EXTENSIONS.join("|")})$`, "i").exec(name);
  if (glued && glued.index > 0) {
    return {
      base: name.slice(0, glued.index).trim(),
      extension: glued[1].toLowerCase(),
      warning: "EXTENSION_WITHOUT_DOT",
    };
  }

  // 3. No extension at all — 606 real files (docs/05 section 1.1).
  return { base: name, extension: null, warning: "MISSING_EXTENSION" };
}

/** Extension -> kind. Unknown/absent extension is treated as an image. */
export function mediaKindFromExtension(extension: string | null): MediaKind {
  if (extension && (VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return "video";
  return "image";
}

/** `image/jpeg` -> image, `video/mp4` -> video. Null for anything else. */
export function mediaKindFromMimeType(mimeType: string | null | undefined): MediaKind | null {
  if (typeof mimeType !== "string") return null;
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("image/")) return "image";
  return null;
}

export function parseMediaFileName(raw: string): ParsedMediaFileName {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      issue: "EMPTY_NAME",
      raw: typeof raw === "string" ? raw : "",
      normalized: "",
      detail: "File name is empty or whitespace only",
    };
  }

  const normalized = normalizeWhitespace(raw);
  const warnings: MediaNameWarning[] = [];
  if (normalized !== raw) warnings.push("LEADING_TRAILING_WHITESPACE");

  const { base, extension, warning: extensionWarning } = splitExtension(normalized);
  if (extensionWarning) warnings.push(extensionWarning);

  // Product code must open the name; a code found later belongs to a file named
  // after a model or a prompt (`DV Huyền Thạch MGAC513 MMQD554.jpg`) and cannot
  // be attributed safely.
  const codeMatches = [...base.toUpperCase().matchAll(PRODUCT_CODE_PATTERN)];
  const first = codeMatches[0];
  if (!first || first.index !== 0) {
    return {
      ok: false,
      issue: "NO_PRODUCT_CODE",
      raw,
      normalized,
      detail: first
        ? `Product code '${first[0]}' does not start the file name`
        : "No product code found in file name",
    };
  }

  const productCode = first[0];

  // Repeats of the SAME code are glued spellings (`...KEMMG0AD6112-AI`), not a
  // second product. They are removed before scanning for foreign codes,
  // otherwise the scan matches one character too far (`TÍMMGTT5139` would look
  // like the invented code `MMGTT5139`).
  const tail = base.slice(productCode.length);
  const tailUpper = tail.toUpperCase();
  const repeatCount = tailUpper.split(productCode).length - 1;
  const foreignCodes = [
    ...tailUpper.split(productCode).join(" ").matchAll(PRODUCT_CODE_PATTERN),
  ].map((match) => match[0]);

  // PENDING(docs/05 section 7 question 6): an outfit set carries two codes in
  // one photo. Temporary rule: attribute it to the code that OPENS the name
  // (the file is named after it) and flag the file, rather than dropping 739
  // real photos or duplicating them under both codes.
  if (foreignCodes.length > 0) warnings.push("MULTIPLE_PRODUCT_CODES");
  if (repeatCount > 0) warnings.push("REPEATED_PRODUCT_CODE");

  // Remainder = everything after the code, minus the repeated code spellings.
  let remainder = tail;
  for (let i = 0; i < repeatCount; i += 1) {
    remainder = remainder.replace(new RegExp(productCode, "i"), " ");
  }

  // Sequence: `(25)`, also glued as `Mặt sau(55)`.
  let sequence: number | null = null;
  const sequenceMatch = /\(\s*(\d{1,4})\s*\)/.exec(remainder);
  if (sequenceMatch) {
    sequence = Number.parseInt(sequenceMatch[1], 10);
    remainder = remainder.replace(sequenceMatch[0], " ");
  } else {
    warnings.push("MISSING_SEQUENCE");
  }

  const variants = { aiGenerated: false, realPhoto: false, backView: false };
  const extraTokens: string[] = [];
  let colorRaw: string | null = null;
  let color: string | null = null;

  // Segments are split on `-` and `_` only: colour names contain spaces
  // (`XANH NHẠT`, `NÂU VÀNG`) and must not be cut there (docs/05 closes B3).
  const segments = remainder
    .split(/[-_]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    // Markers can be glued to the colour by a space (`TRẮNG AI`) and can be two
    // words (`THỰC TẾ`, `MẶT SAU`), so peel words off the tail, longest first.
    const words = segment.split(/\s+/).filter((word) => word.length > 0);
    for (;;) {
      const pairMarker =
        words.length >= 2 ? classifyMarker(colorKey(words.slice(-2).join(""))) : null;
      if (pairMarker) {
        variants[pairMarker] = true;
        words.splice(-2, 2);
        continue;
      }
      const wordMarker = words.length >= 1 ? classifyMarker(colorKey(words[words.length - 1])) : null;
      if (wordMarker) {
        variants[wordMarker] = true;
        words.pop();
        continue;
      }
      break;
    }
    const rest = words.join(" ").trim();
    if (rest.length === 0) continue;

    const canonical = normalizeColorName(rest);
    if (canonical && color === null) {
      color = canonical;
      colorRaw = rest;
      continue;
    }
    // Not a colour (model name, foreign product name, stray digit) — recorded,
    // never merged into the colour (`MG0SV6055-PIERA`, docs/05 section 1.3).
    extraTokens.push(rest);
  }

  if (color === null) {
    // Take the first leftover as the raw colour so operators can still filter
    // on it, but mark it: `AI`-only names (104 files) end up here too.
    const candidate = extraTokens[0] ?? null;
    if (candidate) {
      colorRaw = candidate;
      warnings.push("UNKNOWN_COLOR");
    } else {
      warnings.push("MISSING_COLOR");
    }
  }
  const leftover = color === null ? extraTokens.slice(1) : extraTokens;
  if (leftover.length > 0) warnings.push("EXTRA_TOKENS");

  // Tier 1 = the brief's `CODE-Colour (n).ext` with nothing unexplained left.
  // `-AI` / `-THỰC TẾ` / `-MẶT SAU` markers still count as strict: docs/05
  // counts them as compliant and lists "colour = AI" (no colour at all) as the
  // deviation — that case lands in warnings above.
  const isStrict =
    warnings.length === 0 && color !== null && sequence !== null && extension !== null;

  return {
    ok: true,
    value: {
      raw,
      normalized,
      productCode,
      otherProductCodes: foreignCodes,
      color,
      colorRaw,
      sequence,
      extension,
      kind: mediaKindFromExtension(extension),
      variants,
      extraTokens: leftover,
      warnings,
      isStrict,
    },
  };
}
