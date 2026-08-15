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
import { SHEET_COLUMNS } from "@/core/domain/product";
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
 * The stripped prefix is pinned to the EXACT labels the prompt prints, not to
 * "anything before a colon": a loose rule would turn `sourceText` into a free
 * text field, where "Giá chỉ 350.000: Đầm" would pass review as a grounded
 * claim. Everything after the label still has to be found in the source.
 */
const PROMPT_LABELS = [
  SHEET_COLUMNS.name,
  SHEET_COLUMNS.category,
  SHEET_COLUMNS.season,
  SHEET_COLUMNS.description,
] as const;

/** A label is data, not a pattern: "Nguyên Giá (bắt buộc)" must not become a group. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const LABEL_PREFIX = new RegExp(
  `^\\s*[-*•]?\\s*(?:${PROMPT_LABELS.map((label) => escapeRegExp(normalizeForCompare(label))).join("|")})\\s*:[ \\t]*`,
  "iu",
);

/**
 * Shortest source worth trusting. One character passes almost any containment
 * check, so it is grounding in name only.
 */
const MIN_SOURCE_CHARS = 2;

/** Forms of a declared source worth checking, most literal first. */
function sourceCandidates(rawSourceText: string): string[] {
  const literal = normalizeLoose(rawSourceText);
  const unlabelled = normalizeLoose(rawSourceText.replace(LABEL_PREFIX, ""));
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

  // --- (a) declared claims must be grounded -------------------------------
  for (const claim of content.claims) {
    const candidates = sourceCandidates(claim.sourceText);
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
        `Khẳng định "${claim.statement}" trích nguồn "${claim.sourceText}" không có trong Mô tả sản phẩm/Chủng loại/Mùa vụ.`,
        { statement: claim.statement, source_text: claim.sourceText },
      ),
    );
  }

  // --- (b) facts that slipped past the claim list -------------------------
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
        `Nội dung nhắc chất liệu không có trong Mô tả sản phẩm: ${invented.join(", ")}.`,
        { tokens: invented },
      ),
    );
  }

  return failures;
}
