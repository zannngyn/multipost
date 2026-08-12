/**
 * Stage 2 — BUSINESS rules from the brief, now running on structured data
 * (docs/ai/validation.md §2, brief §7.3–7.4).
 */

import {
  buildCaptionText,
  findForeignNameTokens,
  findProductCodeTokens,
  findSharedWordRun,
  isUpperCaseTitle,
  isWellFormedHashtag,
  normalizeForCompare,
  MAX_SHARED_WORD_RUN,
  type CaptionContent,
} from "@/core/domain/caption";
import { failure, type ValidationContext, type ValidationFailure } from "@/core/ai/validation/types";

export function validateBusiness(
  content: CaptionContent,
  context: ValidationContext,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const { product, constraints, existingCaptions } = context;

  // --- title -------------------------------------------------------------
  if (!isUpperCaseTitle(content.title)) {
    failures.push(
      failure(2, "business.title_not_uppercase", "Tiêu đề phải VIẾT HOA toàn bộ.", {
        title: content.title,
      }),
    );
  }

  const normalizedName = normalizeForCompare(product.name);
  if (normalizedName.length > 0 && normalizeForCompare(content.title).includes(normalizedName)) {
    failures.push(
      failure(
        2,
        "business.title_contains_product_name",
        "Tiêu đề không được chứa tên sản phẩm — hệ thống tự ghép tên vào dòng đầu.",
        { product_name: product.name },
      ),
    );
  }

  // --- name consistency in body (brief §7.4, ca thật MG0SV6055-PIERA) -----
  const sources = [product.description, product.category, product.season];
  const foreignNames = findForeignNameTokens(content.body, product.name, sources);
  if (foreignNames.length > 0) {
    failures.push(
      failure(
        2,
        "business.foreign_product_name",
        `Nội dung nhắc tới tên lạ (${foreignNames.join(", ")}) — chỉ được dùng tên "${product.name}".`,
        { tokens: foreignNames, product_name: product.name },
      ),
    );
  }

  const codes = findProductCodeTokens(content.body);
  if (codes.length > 0) {
    failures.push(
      failure(2, "business.product_code_leaked", `Nội dung chứa mã sản phẩm nội bộ (${codes.join(", ")}).`, {
        tokens: codes,
      }),
    );
  }

  // --- hashtags ----------------------------------------------------------
  const malformed = content.hashtags.filter((tag) => !isWellFormedHashtag(tag));
  if (malformed.length > 0) {
    failures.push(
      failure(2, "business.hashtag_malformed", `Hashtag sai định dạng: ${malformed.join(", ")}.`, {
        tokens: malformed,
      }),
    );
  }

  // --- length ------------------------------------------------------------
  const maxBodyChars = constraints.maxBodyChars;
  if (typeof maxBodyChars === "number" && content.body.trim().length > maxBodyChars) {
    failures.push(
      failure(2, "business.body_too_long", `Nội dung dài hơn giới hạn ${maxBodyChars} ký tự.`, {
        length: content.body.trim().length,
        max: maxBodyChars,
      }),
    );
  }

  // --- cross-channel duplication -----------------------------------------
  // // PENDING(D1) — provisional threshold: no run longer than 8 words shared
  // with a caption already accepted for another channel of the same post.
  const candidate = buildCaptionText(product.name, content);
  for (const existing of existingCaptions) {
    const shared = findSharedWordRun(existing, candidate, MAX_SHARED_WORD_RUN);
    if (!shared) continue;
    failures.push(
      failure(
        2,
        "business.duplicate_with_other_channel",
        `Trùng ${MAX_SHARED_WORD_RUN + 1} từ liên tiếp với caption kênh khác: "${shared}". Viết lại khác hoàn toàn.`,
        { shared_run: shared },
      ),
    );
    break;
  }

  return failures;
}
