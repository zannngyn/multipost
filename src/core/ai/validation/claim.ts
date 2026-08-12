/**
 * Stage 3 — CLAIM validator (docs/ai/validation.md §3, nguyên tắc #5).
 * The only source of truth is the whitelisted product data. Checked both ways:
 *  (a) declared claims  — every `sourceText` must exist in the source text;
 *  (b) leaked facts     — numbers with units and material words in the body
 *                         must exist in the source text too.
 */

import { normalizeLoose, type CaptionContent, type CaptionInput } from "@/core/domain/caption";
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
    const needle = normalizeLoose(claim.sourceText);
    if (needle.length === 0) {
      failures.push(
        failure(3, "claim.empty_source", `Khẳng định "${claim.statement}" không kèm đoạn nguồn.`, {
          statement: claim.statement,
        }),
      );
      continue;
    }
    if (source.includes(needle)) continue;

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
