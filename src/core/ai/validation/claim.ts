/**
 * Stage 3 — CLAIM validator (docs/ai/validation.md §3, nguyên tắc #5).
 * The only source of truth is the whitelisted product data. Checked both ways:
 *  (a) declared claims  — every `sourceText` must exist in the source text;
 *  (b) leaked facts     — numbers with units and material words in the body
 *                         must exist in the source text too.
 */

import {
  normalizeForCompare,
  normalizeLoose,
  type CaptionContent,
  type CaptionInput,
} from "@/core/domain/caption";
import {
  contentColumns,
  MYSP_FIELD_MAP,
  type CatalogFieldMap,
} from "@/core/domain/catalog-field-map";
import { failure, type ValidationContext, type ValidationFailure } from "@/core/ai/validation/types";

/** Vietnamese fashion materials seen in the real sheet + common variants. */
export const MATERIAL_DICTIONARY = [
  "lụa",
  "tơ tằm",
  "tơ",
  "cotton",
  "linen",
  "đũi",
  "voan",
  "ren",
  "kaki",
  "jean",
  "denim",
  "len",
  "dạ",
  "nhung",
  "chiffon",
  "satin",
  "thun",
  "polyester",
  "viscose",
  "modal",
  "tencel",
  "da bò",
  "da lộn",
  "lông vũ",
  "organza",
  "tuyết mưa",
  "gấm",
] as const;

/** A number is a factual claim as soon as it carries a unit. */
const MEASUREMENT_PATTERN =
  /\b\d+(?:[.,]\d+)?\s?(cm|mm|m|kg|g|gram|ml|lít|inch|%|size|sz)\b/giu;

function sourceTextOf(product: CaptionInput): string {
  return normalizeLoose([product.description, product.category, product.season].join(" \n "));
}

/**
 * The prompt shows the product as a labelled list ("- Chủng loại: Áo cộc tay"),
 * so a model told to quote VERBATIM often returns the whole line while the
 * source text here holds only the value. That mismatch is our own formatting
 * artefact, not a hallucination, and it used to block real captions.
 *
 * The stripped prefix is pinned to EXACT labels, not to "anything before a
 * colon": a loose rule would turn `sourceText` into a free text field, where
 * "Giá chỉ 350.000: Đầm" would pass review as a grounded claim. Everything
 * after the label still has to be found in the source.
 *
 * WHICH labels count is per tenant, and both sets are accepted because both can
 * reach a prompt: the shipped template prints the preset's Vietnamese labels
 * for EVERY tenant, while a tenant-authored template normally prints the
 * headers of its own sheet ("Nhóm hàng", "Product name"). A header the tenant
 * never mapped onto a caption field is not a label — it cannot be in a prompt.
 */
const DEFAULT_PROMPT_LABELS: readonly string[] = contentColumns(MYSP_FIELD_MAP);

function promptLabelsFor(map: CatalogFieldMap | null | undefined): readonly string[] {
  const tenantColumns = map ? contentColumns(map) : [];
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const raw of [...DEFAULT_PROMPT_LABELS, ...tenantColumns]) {
    const label = typeof raw === "string" ? raw.trim() : "";
    if (label.length === 0) continue;
    const key = normalizeForCompare(label);
    // A punctuation-only header normalises to "" and would match every
    // "anything: value" — precisely the loose rule this guard rules out.
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  // Longest first: alternation order decides how a line is read, and "Mô tả"
  // must not shadow a tenant's "Mô tả sản phẩm chi tiết".
  return labels.sort((a, b) => b.length - a.length);
}

/** A label is data, not a pattern: "Nguyên Giá (bắt buộc)" must not become a group. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * One compiled matcher per label set. Cached because the set is stable per
 * tenant while `validateClaims` runs once per attempt, and bounded so a
 * pathological number of distinct maps cannot grow it without limit.
 */
const LABEL_PREFIX_CACHE = new Map<string, RegExp>();
const LABEL_PREFIX_CACHE_MAX = 64;

function labelPrefixPattern(labels: readonly string[]): RegExp {
  const key = labels.join("\x00");
  const cached = LABEL_PREFIX_CACHE.get(key);
  if (cached) return cached;

  const alternation = labels.map((label) => escapeRegExp(normalizeForCompare(label))).join("|");
  const pattern = new RegExp(`^\\s*[-*•]?\\s*(?:${alternation})\\s*:[ \\t]*`, "iu");
  if (LABEL_PREFIX_CACHE.size >= LABEL_PREFIX_CACHE_MAX) LABEL_PREFIX_CACHE.clear();
  LABEL_PREFIX_CACHE.set(key, pattern);
  return pattern;
}

/** Operator-facing column name: the tenant's header, the preset's when unmapped. */
function columnLabel(
  map: CatalogFieldMap | null | undefined,
  field: "description" | "category" | "season",
): string {
  const column = map?.[field];
  if (typeof column !== "string") return MYSP_FIELD_MAP[field];
  const trimmed = column.trim();
  return trimmed.length > 0 ? trimmed : MYSP_FIELD_MAP[field];
}

/** The three columns stage 3 checks against, named the way the operator sees them. */
function sourceColumnsLabel(map: CatalogFieldMap | null | undefined): string {
  const labels: string[] = [];
  for (const field of ["description", "category", "season"] as const) {
    const label = columnLabel(map, field);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join("/");
}

/**
 * Shortest source worth trusting. One character passes almost any containment
 * check, so it is grounding in name only.
 */
const MIN_SOURCE_CHARS = 2;

/** Forms of a declared source worth checking, most literal first. */
function sourceCandidates(rawSourceText: string, labelPrefix: RegExp): string[] {
  const literal = normalizeLoose(rawSourceText);
  const unlabelled = normalizeLoose(rawSourceText.replace(labelPrefix, ""));
  const forms = unlabelled.length > 0 && unlabelled !== literal ? [literal, unlabelled] : [literal];
  return forms.filter((form) => form.length >= MIN_SOURCE_CHARS);
}

/** Word-boundary containment — avoids "ren" matching inside an unrelated word. */
function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/** "3 cm" and "3cm" are the same fact — compare with spacing removed. */
function compact(value: string): string {
  return normalizeLoose(value).replace(/\s+/gu, "");
}

export function validateClaims(
  content: CaptionContent,
  context: ValidationContext,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const source = sourceTextOf(context.product);
  const body = content.body;
  const isPureVision = source.trim().length === 0;

  // No map = the MYSP preset, so an internal generation behaves as before.
  const fieldMap = context.fieldMap ?? null;
  const labelPrefix = labelPrefixPattern(promptLabelsFor(fieldMap));
  const sourceColumns = sourceColumnsLabel(fieldMap);

  // --- (a) declared claims must be grounded -------------------------------
  for (const claim of content.claims) {
    if (isPureVision) {
      // In pure vision mode (no text sheet data), claims are grounded on the vision model analysis.
      continue;
    }
    const candidates = sourceCandidates(claim.sourceText, labelPrefix);
    if (candidates.length === 0) {
      const blank = claim.sourceText.trim().length === 0;
      failures.push(
        blank
          ? failure(
              3,
              "claim.empty_source",
              `Khẳng định "${claim.statement}" không kèm đoạn nguồn.`,
              { statement: claim.statement },
            )
          : failure(
              3,
              "claim.source_too_short",
              `Khẳng định "${claim.statement}" có đoạn nguồn quá ngắn để đối chiếu.`,
              { statement: claim.statement, source_text: claim.sourceText },
            ),
      );
      continue;
    }
    // containsPhrase, not includes: a bare substring match lets a one-word
    // `sourceText` land inside an unrelated word and count as grounded.
    if (candidates.some((candidate) => containsPhrase(source, candidate))) continue;

    failures.push(
      failure(
        3,
        "claim.source_not_found",
        `Khẳng định "${claim.statement}" trích nguồn "${claim.sourceText}" không có trong ${sourceColumns}.`,
        { statement: claim.statement, source_text: claim.sourceText },
      ),
    );
  }

  // --- (b) facts that slipped past the claim list -------------------------
  if (!isPureVision) {
    const compactSource = compact(source);
    const measurements = [...body.matchAll(MEASUREMENT_PATTERN)].map((match) => match[0].trim());
    const ungroundedMeasurements = [
      ...new Set(measurements.filter((token) => !compactSource.includes(compact(token)))),
    ];
    if (ungroundedMeasurements.length > 0) {
      failures.push(
        failure(
          3,
          "claim.ungrounded_measurement",
          `Nội dung có thông số không có trong nguồn: ${ungroundedMeasurements.join(", ")}.`,
          { tokens: ungroundedMeasurements },
        ),
      );
    }

    const normalizedBody = normalizeLoose(body);
    const invented = MATERIAL_DICTIONARY.filter((material) => {
      const needle = normalizeLoose(material);
      return containsPhrase(normalizedBody, needle) && !containsPhrase(source, needle);
    });
    if (invented.length > 0) {
      failures.push(
        failure(
          3,
          "claim.invented_material",
          `Nội dung nhắc chất liệu không có trong ${columnLabel(fieldMap, "description")}: ${invented.join(", ")}.`,
          { tokens: invented },
        ),
      );
    }
  }

  return failures;
}
