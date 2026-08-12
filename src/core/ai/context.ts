/**
 * AI context builder — the wall that keeps forbidden columns out of a prompt
 * (CLAUDE.md business rule 2, docs/ai/validation.md §3).
 *
 * Enforcement is structural, not textual: the product object is re-parsed
 * through `captionInputSchema`, which STRIPS every key outside the whitelist.
 * Even if a caller widens `CaptionInput` with a cast, price/stock cannot get in.
 */

import { captionInputSchema, type CaptionInput } from "@/core/domain/caption";
import { AppError } from "@/core/domain/errors";
import type { PromptVariables } from "@/core/ai/prompt-render";
import { describeFailures } from "@/core/ai/validation";
import type { ValidationFailure } from "@/core/ai/validation/types";
import type { ContentGenerationRequest } from "@/core/ports/content-engine";

/** Whitelisted fields, re-derived from the schema so the two cannot drift. */
export const WHITELISTED_PRODUCT_FIELDS = ["name", "description", "category", "season"] as const;

export function toWhitelistedProduct(product: unknown): CaptionInput {
  const parsed = captionInputSchema.safeParse(product);
  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: "Product context failed the caption whitelist schema",
      userMessage: "Dữ liệu sản phẩm không đủ để sinh caption (thiếu tên/mô tả/chủng loại/mùa vụ).",
      context: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    });
  }
  return parsed.data;
}

function renderConstraints(request: ContentGenerationRequest): string {
  const { constraints } = request;
  const lines = [
    `- Kết thúc bằng ${constraints.hashtagMin}–${constraints.hashtagMax} hashtag.`,
    "- TUYỆT ĐỐI không nhắc giá, số tiền, tồn kho hay ghi chú sản xuất.",
    "- Không bịa thông số (cm, kg, %, size) hay chất liệu không có trong Mô tả sản phẩm.",
    "- Tiêu đề VIẾT HOA toàn bộ và KHÔNG chứa tên sản phẩm (hệ thống tự ghép tên vào dòng đầu).",
  ];
  if (typeof constraints.maxBodyChars === "number") {
    lines.push(`- Phần nội dung tối đa ${constraints.maxBodyChars} ký tự.`);
  }
  if (constraints.forbiddenWords && constraints.forbiddenWords.length > 0) {
    lines.push(`- Không dùng các từ: ${constraints.forbiddenWords.join(", ")}.`);
  }
  return lines.join("\n");
}

export interface PromptContextInput {
  request: ContentGenerationRequest;
  product: CaptionInput;
  /** Reasons the previous attempt was rejected — empty on the first attempt. */
  previousFailures: readonly ValidationFailure[];
}

export function buildPromptVariables(input: PromptContextInput): PromptVariables {
  const { request, product, previousFailures } = input;

  const otherCaptions = (request.existingCaptions ?? []).map(
    (caption, index) => `--- Caption kênh ${index + 1} ---\n${caption}`,
  );

  return {
    "product.name": product.name,
    "product.description": product.description,
    "product.category": product.category,
    "product.season": product.season,
    constraints: renderConstraints(request),
    platform: request.platform,
    contentType: request.contentType,
    language: request.language,
    brandVoice: request.brandVoice ?? "",
    otherCaptions: otherCaptions.join("\n\n"),
    previousFailures:
      previousFailures.length === 0
        ? ""
        : `Bản viết trước bị từ chối vì:\n${describeFailures(previousFailures)}\nHãy viết lại và sửa hết các lỗi trên.`,
  };
}
