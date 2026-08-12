/**
 * Stage 4 — CONTENT POLICY (docs/ai/validation.md §2, brief §7.5 + rule 2).
 * Last gate before a human sees the caption: no price, no stock, no production
 * note, no tenant-blacklisted word — in title, body or hashtags.
 */

import {
  findPriceLikeNumbers,
  normalizeForCompare,
  type CaptionContent,
} from "@/core/domain/caption";
import { failure, type ValidationContext, type ValidationFailure } from "@/core/ai/validation/types";

/**
 * Internal-only vocabulary that must never reach a public post. Sourced from the
 * sheet columns the whitelist excludes ("Tồn", "Lưu ý nhận sx 1c / sx hết tồn").
 */
export const INTERNAL_PHRASES = [
  "tồn kho",
  "tồn:",
  "hết tồn",
  "hết hàng",
  "còn hàng số lượng",
  "sx 1c",
  "nhận sx",
  "sản xuất 1c",
  "hàng đặt sản xuất",
  "lưu ý sản xuất",
] as const;

export function validateContentPolicy(
  content: CaptionContent,
  context: ValidationContext,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const surfaces = [content.title, content.body, ...content.hashtags].join("\n");

  // --- price (brief §7.5) --------------------------------------------------
  // // PENDING(D2) — provisional rule: >=5 digits grouped with "." or ",".
  const prices = [...new Set(findPriceLikeNumbers(surfaces))];
  if (prices.length > 0) {
    failures.push(
      failure(4, "policy.price_like_number", `Caption chứa số giống giá tiền: ${prices.join(", ")}.`, {
        tokens: prices,
      }),
    );
  }

  // --- internal-only data --------------------------------------------------
  const normalized = normalizeForCompare(surfaces);
  const internalHits = INTERNAL_PHRASES.filter((phrase) =>
    normalized.includes(normalizeForCompare(phrase)),
  );
  if (internalHits.length > 0) {
    failures.push(
      failure(
        4,
        "policy.internal_info",
        `Caption chứa thông tin nội bộ (tồn kho/ghi chú sản xuất): ${internalHits.join(", ")}.`,
        { tokens: internalHits },
      ),
    );
  }

  // --- tenant blacklist ----------------------------------------------------
  const blacklist = context.constraints.forbiddenWords ?? [];
  const blacklistHits = blacklist.filter((word) => {
    const needle = normalizeForCompare(word);
    return needle.length > 0 && normalized.includes(needle);
  });
  if (blacklistHits.length > 0) {
    failures.push(
      failure(4, "policy.blacklisted_word", `Caption chứa từ bị cấm: ${blacklistHits.join(", ")}.`, {
        tokens: blacklistHits,
      }),
    );
  }

  return failures;
}
