/**
 * Caption domain — pure rules for the text we publish under the shop's brand.
 * No imports except zod (schema-at-the-boundary, no I/O). See docs/07 §2.
 *
 * Two hard constraints encoded here:
 *  - CLAUDE.md business rule 2 (whitelist): `CaptionInput` can ONLY carry the
 *    four sheet columns allowed into a prompt + the cover image. There is no
 *    price/stock/production-note field to leak, by construction.
 *  - Brief §7.3: the first line `Name – EMOTIONAL TITLE` is assembled by the
 *    SYSTEM, never by the model (docs/ai/validation.md §1).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Input — whitelist by construction
// ---------------------------------------------------------------------------

/** Where the cover shot came from: a real photo ("-THỰC TẾ") beats an AI render. */
export type CoverImageKind = "real" | "ai" | "unknown";

export interface CaptionCoverImage {
  /** Drive file id / storage ref — traceability only, never sent to the model. */
  ref: string;
  mimeType: string;
  /** Bytes already resized to ~1024px by the media layer (docs/ai/cost-model.md §4.2). */
  dataBase64: string;
  kind: CoverImageKind;
}

/**
 * Canonical product facts allowed into an AI prompt. Adding a field here is a
 * business decision, not a refactor: anything present WILL reach the model.
 */
export interface CaptionInput {
  /** Sheet "Tên sản phẩm" — the single source of truth for the name (never the file name). */
  name: string;
  /** Sheet "Mô tả sản phẩm". */
  description: string;
  /** Sheet "Chủng loại". */
  category: string;
  /** Sheet "Mùa vụ". */
  season: string;
  coverImage?: CaptionCoverImage;
}

const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const captionCoverImageSchema = z.object({
  ref: z.string().min(1),
  mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
  dataBase64: z.string().min(1),
  kind: z.enum(["real", "ai", "unknown"]),
});

export const captionInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  category: z.string(),
  season: z.string(),
  coverImage: captionCoverImageSchema.optional(),
});

// ---------------------------------------------------------------------------
// Output — what the model returns and what we publish
// ---------------------------------------------------------------------------

export const CLAIM_FIELDS = ["material", "category", "season", "color", "other"] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

export interface CaptionClaim {
  field: ClaimField;
  /** What the model asserted, e.g. "chất liệu tơ óng". */
  statement: string;
  /** The exact span of the whitelisted source the claim leans on. */
  sourceText: string;
}

export interface CaptionContent {
  /** UPPERCASE emotional title WITHOUT the product name (system prepends it). */
  title: string;
  body: string;
  hashtags: string[];
  claims: CaptionClaim[];
  /** Self-reported, observational only — never a gate (docs/ai/validation.md §1). */
  confidence?: number;
}

export interface CaptionResult {
  /** Publish-ready text: "Name – TITLE" + body + hashtags. */
  text: string;
  content: CaptionContent;
}

export const HASHTAG_MIN = 3;
export const HASHTAG_MAX = 5;

/** Brief §7.3 uses an en dash between name and title. */
export const CAPTION_NAME_SEPARATOR = "–";

/**
 * Assemble the publishable caption. The name comes from the Sheet, so the
 * "AI wrote the wrong name" failure class cannot exist on the first line.
 */
export function buildCaptionText(productName: string, content: CaptionContent): string {
  const name = productName.trim();
  const title = content.title.trim();
  const headline = title ? `${name} ${CAPTION_NAME_SEPARATOR} ${title}` : name;
  const body = content.body.trim();
  const hashtags = content.hashtags.map((tag) => tag.trim()).filter(Boolean);

  return [headline, body, hashtags.join(" ")].filter((part) => part.length > 0).join("\n\n");
}

// ---------------------------------------------------------------------------
// Text helpers (pure) — shared by every validation stage
// ---------------------------------------------------------------------------

const PUNCTUATION = /[.,;:!?"'’“”()[\]{}<>/\\|@#$%^&*_+=~`–—-]/gu;

/** Lowercase + collapse whitespace. Diacritics are KEPT: they carry meaning in Vietnamese. */
export function normalizeForCompare(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Same as {@link normalizeForCompare} but punctuation-insensitive — for substring matching. */
export function normalizeLoose(value: string): string {
  return normalizeForCompare(value.normalize("NFC").replace(PUNCTUATION, " "));
}

/** Unicode-aware word split, lowercased. Digits stay (needed by the fact scanner). */
export function toWords(value: string): string[] {
  return normalizeForCompare(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * D1 (PENDING): two captions on the same post must not share a run of more than
 * `maxRun` consecutive words. Returns the offending run, or null when clean.
 * // PENDING(D1) — threshold provisional until PM decides the real measure.
 */
export const MAX_SHARED_WORD_RUN = 8;

export function findSharedWordRun(
  left: string,
  right: string,
  maxRun: number = MAX_SHARED_WORD_RUN,
): string | null {
  // Guard: a non-positive threshold would flag every caption pair.
  if (maxRun < 1) return null;

  const runLength = maxRun + 1;
  const leftWords = toWords(left);
  const rightWords = toWords(right);
  if (leftWords.length < runLength || rightWords.length < runLength) return null;

  const seen = new Set<string>();
  for (let i = 0; i + runLength <= leftWords.length; i += 1) {
    seen.add(leftWords.slice(i, i + runLength).join(" "));
  }
  for (let i = 0; i + runLength <= rightWords.length; i += 1) {
    const gram = rightWords.slice(i, i + runLength).join(" ");
    if (seen.has(gram)) return gram;
  }
  return null;
}

/**
 * D2 (PENDING): "looks like a price" = a number of at least 5 digits written
 * with `.` or `,` grouping, e.g. "750.000", "1.250.000".
 * // PENDING(D2) — provisional regex until PM confirms.
 */
export const PRICE_LIKE_MIN_DIGITS = 5;
const NUMBER_TOKEN = /\d[\d.,]*\d/gu;

export function findPriceLikeNumbers(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const token = match[0];
    if (!/[.,]/u.test(token)) continue;
    const digits = token.replace(/\D/gu, "");
    if (digits.length >= PRICE_LIKE_MIN_DIGITS) hits.push(token);
  }
  return hits;
}

/** Title must be uppercase (brief §7.3). Compared after Unicode uppercasing. */
export function isUpperCaseTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  return trimmed === trimmed.toLocaleUpperCase("vi");
}

const HASHTAG_PATTERN = /^#[\p{L}\p{N}_]+$/u;

export function isWellFormedHashtag(tag: string): boolean {
  return HASHTAG_PATTERN.test(tag.trim());
}

/**
 * Foreign-model-name detector (brief §7.4, real case `MG0SV6055-PIERA`).
 *
 * Heuristic, deliberately conservative: a mid-sentence ASCII capitalised token
 * that appears in neither the product name nor the whitelisted source text is
 * almost always another model's name copied from a file name. Sentence-initial
 * tokens are skipped because Vietnamese sentences legitimately start capitalised.
 * A false positive costs one human review, never a wrong public post.
 */
const ASCII_CAPITALISED = /\b[A-Z][a-zA-Z]{2,}\b/gu;
const ASCII_LOANWORDS = new Set([
  "set",
  "mix",
  "tone",
  "style",
  "look",
  "outfit",
  "layer",
  "vibe",
  "form",
  "design",
  "size",
  "basic",
  "office",
  "lady",
  "chic",
  "elegant",
  "feminine",
  "sale",
]);

export function findForeignNameTokens(body: string, productName: string, sources: string[]): string[] {
  const allowed = new Set<string>();
  for (const word of toWords(productName)) allowed.add(word);
  for (const source of sources) for (const word of toWords(source)) allowed.add(word);

  const hits: string[] = [];
  for (const match of body.matchAll(ASCII_CAPITALISED)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (isSentenceStart(body, index)) continue;

    const lowered = token.toLowerCase();
    if (allowed.has(lowered) || ASCII_LOANWORDS.has(lowered)) continue;
    if (!hits.includes(token)) hits.push(token);
  }
  return hits;
}

function isSentenceStart(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === " " || char === "\t" || char === '"' || char === "'") continue;
    return char === "." || char === "!" || char === "?" || char === "\n" || char === "-";
  }
  return true;
}

/** Product-code-looking token, e.g. "MG0SV6055" — never belongs in public copy. */
const PRODUCT_CODE_PATTERN = /\b(?=[A-Z0-9]{6,}\b)(?=[A-Z0-9]*\d)[A-Z][A-Z0-9]{5,}\b/gu;

export function findProductCodeTokens(text: string): string[] {
  return [...new Set(text.match(PRODUCT_CODE_PATTERN) ?? [])];
}
