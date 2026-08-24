/**
 * Colour vocabulary (E2/E3, onboarding phase 2).
 * Pure TypeScript: no imports, no I/O (docs/07 section 2).
 *
 * WHY THIS FILE EXISTS — it used to live inside `media-file-name.ts` as one
 * hard-coded list. That list is the INTERNAL company's fashion vocabulary
 * ("XANH THAN", "NÂU RÊU"); a furniture or cosmetics tenant has its own words,
 * and a colour we do not know must never cost them a photo. So the vocabulary
 * became a value a tenant can extend (`MediaProfile.colors`), seeded from the
 * built-in list.
 *
 * It is split out rather than left in place so that `media-profile.ts` can
 * validate a tenant vocabulary without importing the parser, and the parser can
 * import the profile TYPE — no cycle either way (dependency-cruiser runs with
 * `tsPreCompilationDeps: true`, so a type-only cycle would fail the build).
 *
 * Colour is ALWAYS optional data: an unrecognised colour means "ảnh này không
 * phân màu", never a rejected file.
 */

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

/**
 * Extra spellings that do not collapse onto a canonical colour by themselves.
 * Keep this list short and evidence-based — every entry must come from a real
 * file name, never from a guess. `OD` (14 files) is deliberately absent: it may
 * be a typo of `ĐỎ` or an unrelated marker, and guessing would mislabel photos.
 */
export const BUILT_IN_COLOR_ALIASES: Readonly<Record<string, string>> = {
  "XANH NHAT": "XANH NHẠT",
  "XANH DUONG": "XANH DƯƠNG",
  "HONG TIM": "HỒNG TÍM",
  "HONG KEM": "HỒNG KEM",
  "NAU BE": "NÂU BE",
  "NAU HONG": "NÂU HỒNG",
  "BE CAM": "BE CAM",
};

/** Per-tenant vocabulary, stored inside `MediaProfile.colors`. */
export interface ColorVocabularyConfig {
  /** The tenant's own colour names. Merged with the built-ins by default. */
  readonly canonical?: readonly string[];
  /** Extra spelling -> canonical name (`"XANHTHAN" -> "XANH THAN"`). */
  readonly aliases?: Readonly<Record<string, string>>;
  /**
   * `false` = start from an empty vocabulary and use `canonical` alone, for a
   * tenant whose "colours" are sizes or scents and for whom `KEM` is noise.
   * Default `true` — an absent config must behave exactly as before.
   */
  readonly includeDefaults?: boolean;
}

export interface ColorVocabulary {
  /** Canonical names, in the order they will be offered to an operator. */
  readonly canonical: readonly string[];
  /** Canonical colour for any spelling, or null when it is unknown. */
  resolve(raw: string): string | null;
}

function buildIndex(
  canonical: readonly string[],
  aliases: Readonly<Record<string, string>>,
): { canonical: string[]; byKey: Map<string, string> } {
  const byKey = new Map<string, string>();
  const ordered: string[] = [];

  for (const name of canonical) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    const key = colorKey(trimmed);
    if (key.length === 0 || byKey.has(key)) continue;
    byKey.set(key, trimmed);
    ordered.push(trimmed);
  }

  // Aliases are applied AFTER the canonical index so a tenant cannot shadow a
  // colour it also declared canonical — the canonical spelling always wins.
  for (const [spelling, target] of Object.entries(aliases)) {
    if (typeof spelling !== "string" || typeof target !== "string") continue;
    const key = colorKey(spelling);
    const canonicalTarget = byKey.get(colorKey(target)) ?? target.trim();
    if (key.length === 0 || canonicalTarget.length === 0 || byKey.has(key)) continue;
    byKey.set(key, canonicalTarget);
  }

  return { canonical: ordered, byKey };
}

const defaultIndex = buildIndex([...CANONICAL_COLORS], BUILT_IN_COLOR_ALIASES);

/** The built-in vocabulary — the default of every `colors` parameter. */
export const DEFAULT_COLOR_VOCABULARY: ColorVocabulary = {
  canonical: defaultIndex.canonical,
  resolve: (raw: string) => defaultIndex.byKey.get(colorKey(raw)) ?? null,
};

/**
 * Memoised per config OBJECT, because the parser is called once per file: a
 * 5,500-file sync would otherwise rebuild the same index 5,500 times.
 * Identity-keyed, so a caller must not mutate a config it has handed in.
 */
const vocabularyCache = new WeakMap<object, ColorVocabulary>();

/**
 * Builds a vocabulary. An absent/empty config returns the built-in one, which
 * is what every tenant configured before phase 2 keeps using.
 */
export function buildColorVocabulary(config?: ColorVocabularyConfig | null): ColorVocabulary {
  if (config && typeof config === "object") {
    const cached = vocabularyCache.get(config);
    if (cached) return cached;
    const built = buildColorVocabularyUncached(config);
    vocabularyCache.set(config, built);
    return built;
  }
  return buildColorVocabularyUncached(config);
}

function buildColorVocabularyUncached(config?: ColorVocabularyConfig | null): ColorVocabulary {
  const includeDefaults = config?.includeDefaults !== false;
  const extraCanonical = Array.isArray(config?.canonical) ? config.canonical : [];
  const extraAliases = config?.aliases && typeof config.aliases === "object" ? config.aliases : {};

  if (includeDefaults && extraCanonical.length === 0 && Object.keys(extraAliases).length === 0) {
    return DEFAULT_COLOR_VOCABULARY;
  }

  // Tenant names come FIRST: on an equal comparison key their spelling is the
  // one an operator sees.
  const canonical = includeDefaults ? [...extraCanonical, ...CANONICAL_COLORS] : [...extraCanonical];
  const aliases = includeDefaults
    ? { ...BUILT_IN_COLOR_ALIASES, ...extraAliases }
    : { ...extraAliases };

  const index = buildIndex(canonical, aliases);
  return {
    canonical: index.canonical,
    resolve: (raw: string) => index.byKey.get(colorKey(raw)) ?? null,
  };
}

/** Canonical colour for any spelling in the BUILT-IN vocabulary, or null. */
export function normalizeColorName(raw: string): string | null {
  return DEFAULT_COLOR_VOCABULARY.resolve(raw);
}

/**
 * True when two colour spellings mean the same colour (`NAU` === `NÂU`).
 * Falls back to the raw comparison key so two unknown-but-identical spellings
 * still match — a tenant vocabulary we do not have must not split an album.
 */
export function isSameColor(
  a: string,
  b: string,
  vocabulary: ColorVocabulary = DEFAULT_COLOR_VOCABULARY,
): boolean {
  const canonicalA = vocabulary.resolve(a);
  const canonicalB = vocabulary.resolve(b);
  if (canonicalA && canonicalB) return canonicalA === canonicalB;
  return colorKey(a) === colorKey(b) && colorKey(a).length > 0;
}
