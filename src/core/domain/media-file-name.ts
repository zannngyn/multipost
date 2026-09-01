/**
 * Drive file-name parser (E2).
 * Pure TypeScript: imports only sibling domain modules (docs/07 section 2).
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
 *
 * PHASE 2 — the two tiers above describe ONE convention, the internal
 * company's. `parseMediaFileName(raw, profile, context)` now takes the tenant's
 * `MediaProfile`:
 *   - absent / `code-color-seq`: byte-for-byte the behaviour described above;
 *   - `code-in-name`: the code may sit anywhere in the name, any delimiter;
 *   - `folder-per-code` / `sheet-column`: the code is decided OUTSIDE the name
 *     and handed in via `context.productCode`; the name only contributes
 *     colour/sequence/extension when it happens to carry them.
 *
 * For every profile except `code-color-seq` a colour that does not resolve is
 * NOT a warning: the asset is "không phân màu" and stays perfectly usable.
 */

import { buildColorVocabulary, type ColorVocabulary } from "./media-colors";
import { resolveMediaProfile, type MediaProfile } from "./media-profile";

// Colour vocabulary moved to `media-colors.ts` in phase 2 so a tenant can
// extend it. Re-exported here because every existing caller imports it from
// this module and their behaviour is unchanged.
export {
  BUILT_IN_COLOR_ALIASES,
  buildColorVocabulary,
  CANONICAL_COLORS,
  colorKey,
  DEFAULT_COLOR_VOCABULARY,
  isSameColor,
  normalizeColorName,
  type ColorVocabulary,
  type ColorVocabularyConfig,
} from "./media-colors";

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

/** Where the product code of an asset was decided. */
export const MEDIA_CODE_SOURCES = [
  /** The name opens with it — the internal convention. */
  "name-leading",
  /** Found somewhere inside the name (`code-in-name`). */
  "name-inner",
  /** Decided outside the name: folder name, or a sheet cell. */
  "external",
] as const;
export type MediaCodeSource = (typeof MEDIA_CODE_SOURCES)[number];

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
  /** How `productCode` was decided — the operator's "vì sao ảnh này vào mã đó". */
  readonly codeSource: MediaCodeSource;
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
      /**
       * Sentence for the "skipped files" screen — VIETNAMESE: it is shown to
       * operators as-is (CLAUDE.md technical rule 6). The machine-readable part
       * is `issue`, which stays English.
       */
      readonly detail: string;
    };

/** What the caller knows that the file name does not. */
export interface MediaNameContext {
  /**
   * Product codes read from the tenant's sheet. With them, `code-in-name` can
   * recognise a code of ANY shape (`SP-001`, `AB.12`), which is the only way
   * to serve a tenant whose codes do not look like ours.
   */
  readonly knownCodes?: ReadonlySet<string> | readonly string[];
  /**
   * The code decided outside the file name — the folder name for
   * `folder-per-code`, the sheet row for `sheet-column`. When present, the
   * parser does not look for a code in the name at all.
   */
  readonly productCode?: string | null;
}

// --- Product code -----------------------------------------------------------

/**
 * Shape observed in both sources: 2 brand letters, an optional line character,
 * 2 category letters, 3-4 digits (`MMAC546`, `MG0AD6112`, `MRKVX6371`).
 * Verified against all 299 sheet codes (docs/05 section 2.1).
 *
 * It is the INTERNAL company's shape. Outside tenants are served by
 * `context.knownCodes` (their own sheet), not by widening this pattern —
 * a looser regex would turn "IMG_1664" into a product code.
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

/** Shortest known code we will look for inside a free-form name. */
const MIN_KNOWN_CODE_LENGTH = 3;

/**
 * Normalised + sorted code list, memoised per COLLECTION object: the parser
 * runs once per file, and re-sorting 299 codes for each of 5,500 files is the
 * difference between a fast sync and a slow one. Identity-keyed, so a caller
 * must not mutate a collection it has handed in.
 */
const knownCodeCache = new WeakMap<object, readonly string[]>();

function prepareKnownCodes(
  knownCodes: ReadonlySet<string> | readonly string[],
): readonly string[] {
  const cached = knownCodeCache.get(knownCodes as object);
  if (cached) return cached;
  const list = [...(knownCodes instanceof Set ? knownCodes : new Set(knownCodes))]
    .filter((code): code is string => typeof code === "string")
    .map(normalizeProductCode)
    .filter((code) => code.length >= MIN_KNOWN_CODE_LENGTH)
    // Longest first, so a code that is the prefix of another cannot win.
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  knownCodeCache.set(knownCodes as object, list);
  return list;
}

/**
 * Finds a known code inside a free-form name.
 *
 * Longest first, so `MG0AD6112B` is not read as `MG0AD6112`. Codes shorter than
 * three characters are ignored: "A1" would match half the folder.
 */
export function findKnownCodes(
  upperName: string,
  knownCodes: ReadonlySet<string> | readonly string[] | undefined,
): readonly { code: string; index: number }[] {
  if (!knownCodes) return [];
  const list = prepareKnownCodes(knownCodes);

  const found: { code: string; index: number }[] = [];
  const taken: Array<[number, number]> = [];
  for (const code of list) {
    const index = upperName.indexOf(code);
    if (index === -1) continue;
    // A longer code already covering this span wins (`MG0AD6112B` vs `MG0AD6112`).
    if (taken.some(([start, end]) => index >= start && index < end)) continue;
    taken.push([index, index + code.length]);
    found.push({ code, index });
  }
  return found.sort((a, b) => a.index - b.index);
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

/** Local copy of the colour comparison key (see media-colors.colorKey). */
function markerKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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

/**
 * Tên file đã chuẩn hoá khoảng trắng và bỏ phần đuôi — phần "stem" mà tầng
 * candidate của upload (core/domain/upload-candidate-code) cần.
 *
 * Dùng chung `normalizeWhitespace` + `splitExtension` với parser chính, để hai
 * bên không thể lệch nhau về "đuôi file là gì" (`.jpg`, `JPG` dính liền,
 * `.2025` bị nhầm là đuôi).
 */
export function mediaFileStem(raw: string): string {
  if (typeof raw !== "string") return "";
  return splitExtension(normalizeWhitespace(raw)).base.trim();
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

type CodeResolution =
  | {
      ok: true;
      productCode: string;
      codeSource: MediaCodeSource;
      /** The name with the code (and its repetitions) removed. */
      remainder: string;
      otherProductCodes: readonly string[];
      warnings: readonly MediaNameWarning[];
    }
  | { ok: false; detail: string };

/**
 * The internal convention: the code must OPEN the name. A code found later
 * belongs to a file named after a model or a prompt
 * (`DV Huyền Thạch MGAC513 MMQD554.jpg`) and cannot be attributed safely.
 */
function resolveLeadingCode(base: string): CodeResolution {
  const upper = base.toUpperCase();
  const codeMatches = [...upper.matchAll(PRODUCT_CODE_PATTERN)];
  const first = codeMatches[0];
  if (!first || first.index !== 0) {
    return {
      ok: false,
      detail: first
        ? `Mã '${first[0]}' nằm giữa tên file chứ không đứng đầu — đổi tên thành '${first[0]}-Màu (số)' rồi đồng bộ lại.`
        : "Tên file không chứa mã sản phẩm nào — đổi tên theo mẫu MÃSP-Màu (số) rồi đồng bộ lại.",
    };
  }

  const productCode = first[0];
  const warnings: MediaNameWarning[] = [];

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

  let remainder = tail;
  for (let i = 0; i < repeatCount; i += 1) {
    remainder = remainder.replace(new RegExp(productCode, "i"), " ");
  }

  return { ok: true, productCode, codeSource: "name-leading", remainder, otherProductCodes: foreignCodes, warnings };
}

/**
 * `code-in-name`: the code may sit anywhere, behind any delimiter. The tenant's
 * OWN codes (from their sheet) are tried first, so a shape we have never seen
 * still works; the internal pattern is only the fallback.
 */
function resolveInnerCode(base: string, context: MediaNameContext | null | undefined): CodeResolution {
  const upper = base.toUpperCase();
  const known = findKnownCodes(upper, context?.knownCodes);
  const matches: readonly { code: string; index: number }[] =
    known.length > 0
      ? known
      : [...upper.matchAll(PRODUCT_CODE_PATTERN)].map((match) => ({
          code: match[0],
          index: match.index ?? 0,
        }));

  const first = matches[0];
  if (!first) {
    return {
      ok: false,
      detail:
        "Tên file không chứa mã sản phẩm nào của bảng tính — đổi tên file cho có mã, hoặc chuyển sang cách 'mỗi mã một thư mục'.",
    };
  }

  const warnings: MediaNameWarning[] = [];
  const others = [
    ...new Set(matches.slice(1).map((match) => match.code).filter((code) => code !== first.code)),
  ];
  if (others.length > 0) warnings.push("MULTIPLE_PRODUCT_CODES");

  // Every occurrence of the chosen code is cut out; what is left feeds the
  // colour/sequence scan.
  const remainder = splitOnCode(base, first.code);
  if (remainder.repeats > 1) warnings.push("REPEATED_PRODUCT_CODE");

  return {
    ok: true,
    productCode: first.code,
    codeSource: first.index === 0 ? "name-leading" : "name-inner",
    remainder: remainder.text,
    otherProductCodes: others,
    warnings,
  };
}

/**
 * Removes every case-insensitive occurrence of `code` from `text`, keeping the
 * rest exactly as written (the colour still needs its diacritics).
 *
 * Split on a regex rather than on an upper-cased copy: upper-casing can change
 * a string's LENGTH, which would shift every offset by one and cut the colour
 * in half.
 */
function splitOnCode(text: string, code: string): { text: string; repeats: number } {
  const pieces = text.split(new RegExp(escapeRegExp(code), "gi"));
  if (pieces.length === 1) return { text, repeats: 0 };
  return { text: pieces.join(" "), repeats: pieces.length - 1 };
}

/** A tenant code may hold `.`/`+`/`(` — none of them may act as a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AttributeScan {
  color: string | null;
  colorRaw: string | null;
  sequence: number | null;
  variants: MediaVariantFlags;
  extraTokens: string[];
}

/**
 * Colour / sequence / `-AI` markers out of whatever is left of the name.
 *
 * `strict` = the internal convention, where a missing colour or sequence is a
 * reported deviation. For every other profile the file name promises nothing,
 * so the same absence is simply "không phân màu" and produces no warning —
 * that is the rule that keeps a customer's `IMG_1664.jpg` usable.
 */
function scanAttributes(
  remainder: string,
  vocabulary: ColorVocabulary,
  strict: boolean,
  warnings: MediaNameWarning[],
): AttributeScan {
  let rest = remainder;

  // Sequence: `(25)`, also glued as `Mặt sau(55)`.
  let sequence: number | null = null;
  const sequenceMatch = /\(\s*(\d{1,4})\s*\)/.exec(rest);
  if (sequenceMatch) {
    sequence = Number.parseInt(sequenceMatch[1], 10);
    rest = rest.replace(sequenceMatch[0], " ");
  } else if (strict) {
    warnings.push("MISSING_SEQUENCE");
  }

  const variants = { aiGenerated: false, realPhoto: false, backView: false };
  const extraTokens: string[] = [];
  let colorRaw: string | null = null;
  let color: string | null = null;

  // Segments are split on `-` and `_` only: colour names contain spaces
  // (`XANH NHẠT`, `NÂU VÀNG`) and must not be cut there (docs/05 closes B3).
  const segments = rest
    .split(/[-_]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    // Markers can be glued to the colour by a space (`TRẮNG AI`) and can be two
    // words (`THỰC TẾ`, `MẶT SAU`), so peel words off the tail, longest first.
    const words = segment.split(/\s+/).filter((word) => word.length > 0);
    for (;;) {
      const pairMarker =
        words.length >= 2 ? classifyMarker(markerKey(words.slice(-2).join(""))) : null;
      if (pairMarker) {
        variants[pairMarker] = true;
        words.splice(-2, 2);
        continue;
      }
      const wordMarker =
        words.length >= 1 ? classifyMarker(markerKey(words[words.length - 1])) : null;
      if (wordMarker) {
        variants[wordMarker] = true;
        words.pop();
        continue;
      }
      break;
    }
    const segmentRest = words.join(" ").trim();
    if (segmentRest.length === 0) continue;

    const canonical = vocabulary.resolve(segmentRest);
    if (canonical && color === null) {
      color = canonical;
      colorRaw = segmentRest;
      continue;
    }
    // Not a colour (model name, foreign product name, stray digit) — recorded,
    // never merged into the colour (`MG0SV6055-PIERA`, docs/05 section 1.3).
    extraTokens.push(segmentRest);
  }

  if (color === null && !strict) {
    // Free-form names put the colour in the middle of a sentence
    // ("anh mau kem chup that.jpg"), so look word by word before giving up.
    const window = findColorInWords(extraTokens, vocabulary);
    if (window) {
      color = window.color;
      colorRaw = window.raw;
    }
    // No colour found: the asset is simply not split by colour. No warning —
    // this profile never promised one.
    return { color, colorRaw, sequence, variants, extraTokens };
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
  if (strict && leftover.length > 0) warnings.push("EXTRA_TOKENS");

  return { color, colorRaw, sequence, variants, extraTokens: leftover };
}

/** Two-word then one-word windows of the leftovers, first colour wins. */
function findColorInWords(
  tokens: readonly string[],
  vocabulary: ColorVocabulary,
): { color: string; raw: string } | null {
  for (const token of tokens) {
    const words = token.split(/\s+/).filter((word) => word.length > 0);
    for (let size = 2; size >= 1; size -= 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        const raw = words.slice(start, start + size).join(" ");
        const canonical = vocabulary.resolve(raw);
        if (canonical) return { color: canonical, raw };
      }
    }
  }
  return null;
}

/**
 * @param profile the tenant's media profile. Absent = `code-color-seq`, the
 *   internal convention: identical behaviour to before phase 2.
 * @param context what the caller knows that the name does not (the sheet's
 *   codes, or a code taken from the folder / a sheet cell).
 */
export function parseMediaFileName(
  raw: string,
  profile?: MediaProfile | null,
  context?: MediaNameContext | null,
): ParsedMediaFileName {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      issue: "EMPTY_NAME",
      raw: typeof raw === "string" ? raw : "",
      normalized: "",
      detail: "Tên file trống hoặc chỉ có khoảng trắng — đặt lại tên theo mẫu MÃSP-Màu (số).",
    };
  }

  const kind = resolveMediaProfile(profile).kind;
  const strict = kind === "code-color-seq";
  const vocabulary = buildColorVocabulary(profile?.colors);

  const normalized = normalizeWhitespace(raw);
  const warnings: MediaNameWarning[] = [];
  if (normalized !== raw) warnings.push("LEADING_TRAILING_WHITESPACE");

  const { base, extension, warning: extensionWarning } = splitExtension(normalized);
  if (extensionWarning) warnings.push(extensionWarning);

  const resolved = resolveCode(base, kind, context);
  if (!resolved.ok) {
    return { ok: false, issue: "NO_PRODUCT_CODE", raw, normalized, detail: resolved.detail };
  }
  warnings.push(...resolved.warnings);

  // `sheet-column`: the name is NOT parsed at all. The operator pointed at this
  // file from their own sheet, so nothing in the name may add a colour, a
  // sequence or a "cần xem lại" flag. Only the extension is read, because the
  // caller still has to know whether it is an image or a video.
  if (kind === "sheet-column") {
    return {
      ok: true,
      value: {
        raw,
        normalized,
        productCode: resolved.productCode,
        codeSource: resolved.codeSource,
        otherProductCodes: [],
        color: null,
        colorRaw: null,
        sequence: null,
        extension,
        kind: mediaKindFromExtension(extension),
        variants: { aiGenerated: false, realPhoto: false, backView: false },
        extraTokens: [],
        warnings: [],
        isStrict: true,
      },
    };
  }

  const attributes = scanAttributes(resolved.remainder, vocabulary, strict, warnings);

  // Tier 1 = the brief's `CODE-Colour (n).ext` with nothing unexplained left.
  // `-AI` / `-THỰC TẾ` / `-MẶT SAU` markers still count as strict: docs/05
  // counts them as compliant and lists "colour = AI" (no colour at all) as the
  // deviation — that case lands in warnings above.
  //
  // For the other profiles "strict" only means "nothing to report": a missing
  // colour is expected there, so it must not brand every file "cần xem lại".
  const isStrict = strict
    ? warnings.length === 0 &&
      attributes.color !== null &&
      attributes.sequence !== null &&
      extension !== null
    : warnings.length === 0 && extension !== null;

  return {
    ok: true,
    value: {
      raw,
      normalized,
      productCode: resolved.productCode,
      codeSource: resolved.codeSource,
      otherProductCodes: resolved.otherProductCodes,
      color: attributes.color,
      colorRaw: attributes.colorRaw,
      sequence: attributes.sequence,
      extension,
      kind: mediaKindFromExtension(extension),
      variants: attributes.variants,
      extraTokens: attributes.extraTokens,
      warnings,
      isStrict,
    },
  };
}

/** Which of the four code strategies applies, edge cases first. */
function resolveCode(
  base: string,
  kind: MediaProfile["kind"],
  context: MediaNameContext | null | undefined,
): CodeResolution {
  // A code handed in from outside always wins: the folder name / sheet cell is
  // the tenant's declared truth, the file name is not.
  const external = normalizeProductCode(context?.productCode ?? "");
  if (external.length > 0) {
    const stripped = splitOnCode(base, external);
    return {
      ok: true,
      productCode: external,
      codeSource: "external",
      remainder: stripped.text,
      otherProductCodes: [],
      warnings: [],
    };
  }

  if (kind === "folder-per-code") {
    return {
      ok: false,
      detail:
        "File không nằm trong thư mục mã sản phẩm nào (đang để ngay thư mục gốc) — chuyển file vào thư mục mang tên mã rồi đồng bộ lại.",
    };
  }
  if (kind === "sheet-column") {
    return {
      ok: false,
      detail:
        "Không có dòng nào trên bảng tính trỏ link tới file này — điền link ảnh vào cột đã khai báo rồi đồng bộ lại.",
    };
  }
  if (kind === "code-in-name") return resolveInnerCode(base, context);
  return resolveLeadingCode(base);
}
