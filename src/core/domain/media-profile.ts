/**
 * Per-tenant media profile (onboarding phase 2) — "ảnh của khách nằm ở đâu và
 * mã sản phẩm được ghi ở chỗ nào".
 * Pure TypeScript: imports only the colour vocabulary (docs/07 section 2).
 *
 * WHY: phase 1 moved the SHEET column names out of the code. The photo half was
 * still hard-coded in two places, and both are the internal company's own
 * habits, not a law of nature:
 *   1. the Drive folder is listed FLAT — a tenant who keeps one sub-folder per
 *      product code gets zero files;
 *   2. the file name must be `MÃ-Màu (số).ext` with the code FIRST — a tenant
 *      whose photos are `IMG_1664.jpg` inside `MG0AD6112/` gets zero files too.
 *
 * A `MediaProfile` is stored next to `fieldMap` in `tenant_integration.config`
 * and says which of the four shapes this tenant's Drive has. Absent = the
 * internal convention (`code-color-seq`), so nothing changes for anybody who
 * was already syncing.
 *
 * NAME CLASH, on purpose kept: `profile-catalog-source.ts` also exports a
 * `MediaProfile` — that one is a SECTION OF THE REPORT (how many files parsed).
 * This one is CONFIGURATION. The report imports this type under the alias
 * `MediaProfileConfig`.
 */

import { buildColorVocabulary, colorKey, type ColorVocabularyConfig } from "./media-colors";

/**
 * The four shapes, in the order the profiler tries them. Order is priority:
 * an earlier kind wins a tie, because it needs less from the tenant's data.
 *
 *   sheet-column    — a column of the tenant's own sheet holds a Drive link or
 *                     id (the `mediaLink` slot of CatalogFieldMap). Nothing is
 *                     parsed out of file names at all: no naming convention, no
 *                     colour vocabulary needed. The fastest way in for a tenant
 *                     whose file names are hopeless.
 *   folder-per-code — one sub-folder per product code, file names free. The
 *                     code comes from the FOLDER name (requires a recursive
 *                     listing, see DriveSource.listFilesDeep).
 *   code-in-name    — the code appears somewhere in the file name, any
 *                     delimiter (`-`, `_`, space, `.`), not necessarily first.
 *   code-color-seq  — the internal convention `MÃ-Màu (số).ext`. DEFAULT.
 */
export const MEDIA_PROFILE_KINDS = [
  "sheet-column",
  "folder-per-code",
  "code-in-name",
  "code-color-seq",
] as const;
export type MediaProfileKind = (typeof MEDIA_PROFILE_KINDS)[number];

interface MediaProfileBase {
  /**
   * The tenant's colour words. Absent = the built-in Vietnamese fashion
   * vocabulary. A colour that resolves to nothing is NOT an error anywhere:
   * the asset simply carries `color: null` ("không phân màu").
   */
  readonly colors?: ColorVocabularyConfig;
}

export interface SheetColumnMediaProfile extends MediaProfileBase {
  readonly kind: "sheet-column";
}
export interface FolderPerCodeMediaProfile extends MediaProfileBase {
  readonly kind: "folder-per-code";
}
export interface CodeInNameMediaProfile extends MediaProfileBase {
  readonly kind: "code-in-name";
}
export interface CodeColorSeqMediaProfile extends MediaProfileBase {
  readonly kind: "code-color-seq";
}

export type MediaProfile =
  | SheetColumnMediaProfile
  | FolderPerCodeMediaProfile
  | CodeInNameMediaProfile
  | CodeColorSeqMediaProfile;

/** What a tenant with nothing configured gets — today's behaviour, unchanged. */
export const DEFAULT_MEDIA_PROFILE: MediaProfile = { kind: "code-color-seq" };

/** Operator-facing name of each kind (Vietnamese), for the onboarding screen. */
export const MEDIA_PROFILE_LABELS: Record<MediaProfileKind, string> = {
  "sheet-column": "Link ảnh nằm trên một cột của bảng tính",
  "folder-per-code": "Mỗi mã sản phẩm một thư mục con trên Drive",
  "code-in-name": "Mã sản phẩm nằm đâu đó trong tên file",
  "code-color-seq": "Tên file theo mẫu MÃ-Màu (số).ext",
};

/** Null/undefined -> the default; anything else is returned as given. */
export function resolveMediaProfile(profile: MediaProfile | null | undefined): MediaProfile {
  if (!profile || typeof profile !== "object") return DEFAULT_MEDIA_PROFILE;
  const kind = (profile as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !isMediaProfileKind(kind)) return DEFAULT_MEDIA_PROFILE;
  return profile;
}

export function isMediaProfileKind(value: unknown): value is MediaProfileKind {
  return typeof value === "string" && (MEDIA_PROFILE_KINDS as readonly string[]).includes(value);
}

/**
 * True when this profile can only be answered by a RECURSIVE Drive listing.
 *
 * Kept as one function because it is also the quota guard: a flat listing is
 * one query per page, a deep one is a query per folder batch, and no tenant
 * should pay that unless their layout requires it.
 *
 * `sheet-column` is included: the link in the cell is very often a FOLDER, and
 * its files only appear when sub-folders are walked.
 */
export function mediaProfileNeedsRecursion(profile: MediaProfile | null | undefined): boolean {
  const kind = resolveMediaProfile(profile).kind;
  return kind === "folder-per-code" || kind === "sheet-column";
}

/** True when the file NAME is expected to carry a colour for this profile. */
export function mediaProfileExpectsColorInName(profile: MediaProfile | null | undefined): boolean {
  return resolveMediaProfile(profile).kind === "code-color-seq";
}

/** True when the profile needs the `mediaLink` slot of the field map. */
export function mediaProfileNeedsLinkColumn(profile: MediaProfile | null | undefined): boolean {
  return resolveMediaProfile(profile).kind === "sheet-column";
}

// --- Validation -------------------------------------------------------------

export const MEDIA_PROFILE_ISSUE_CODES = [
  /** `kind` missing or not one of the four. */
  "MEDIA_PROFILE_KIND_INVALID",
  /** `includeDefaults: false` with no colour of its own — no colour resolves. */
  "MEDIA_PROFILE_COLORS_EMPTY",
  /** An alias points at a name that is in no vocabulary. */
  "MEDIA_PROFILE_ALIAS_UNKNOWN",
  /** The same spelling declared twice (after casefold/diacritic folding). */
  "MEDIA_PROFILE_COLOR_DUPLICATE",
] as const;
export type MediaProfileIssueCode = (typeof MEDIA_PROFILE_ISSUE_CODES)[number];

export interface MediaProfileIssue {
  readonly code: MediaProfileIssueCode;
  /** `error` blocks a sync; `warning` is shown and the sync continues. */
  readonly severity: "error" | "warning";
  /** Sentence for the OPERATOR — Vietnamese. */
  readonly detail: string;
}

/**
 * Returns values, never throws. An empty array means the profile is usable.
 *
 * Deliberately lenient about COLOURS (warnings, not errors): a mistyped alias
 * costs a colour filter, never a photo, and a sync that stops because somebody
 * wrote "xah" would be worse than the mistake.
 */
export function validateMediaProfile(
  profile: MediaProfile | null | undefined,
): readonly MediaProfileIssue[] {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (profile === null || profile === undefined) return [];

  const kind = (profile as { kind?: unknown }).kind;
  if (!isMediaProfileKind(kind)) {
    return [
      {
        code: "MEDIA_PROFILE_KIND_INVALID",
        severity: "error",
        detail: `Kiểu nguồn ảnh không hợp lệ (${String(kind ?? "trống")}) — chỉ nhận: ${MEDIA_PROFILE_KINDS.join(", ")}.`,
      },
    ];
  }

  const colors = profile.colors;
  if (!colors || typeof colors !== "object") return [];

  const issues: MediaProfileIssue[] = [];
  const canonical = Array.isArray(colors.canonical) ? colors.canonical : [];
  const usable = canonical.filter((name) => typeof name === "string" && name.trim().length > 0);
  const includeDefaults = colors.includeDefaults !== false;

  if (!includeDefaults && usable.length === 0) {
    issues.push({
      code: "MEDIA_PROFILE_COLORS_EMPTY",
      severity: "warning",
      detail:
        "Đã tắt bộ màu mặc định nhưng chưa khai màu nào — ảnh sẽ không được phân theo màu (vẫn đăng được bình thường).",
    });
  }

  const seen = new Set<string>();
  for (const name of usable) {
    const key = colorKey(name);
    if (key.length === 0) continue;
    if (seen.has(key)) {
      issues.push({
        code: "MEDIA_PROFILE_COLOR_DUPLICATE",
        severity: "warning",
        detail: `Màu '${name.trim()}' bị khai trùng (không phân biệt hoa thường/dấu) — hệ thống chỉ giữ cách viết đầu tiên.`,
      });
      continue;
    }
    seen.add(key);
  }

  // An alias is checked against the vocabulary it will actually be built with,
  // built-ins included when they are not turned off.
  const vocabulary = buildColorVocabulary(colors);
  const aliases = colors.aliases && typeof colors.aliases === "object" ? colors.aliases : {};
  for (const [spelling, target] of Object.entries(aliases)) {
    if (typeof spelling !== "string" || typeof target !== "string") continue;
    if (vocabulary.resolve(target) !== null) continue;
    issues.push({
      code: "MEDIA_PROFILE_ALIAS_UNKNOWN",
      severity: "warning",
      detail: `Cách viết '${spelling}' đang trỏ tới màu '${target}' chưa có trong danh sách màu — kiểm tra lại chính tả.`,
    });
  }

  return issues;
}
