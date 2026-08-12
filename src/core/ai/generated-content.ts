/**
 * GeneratedContent — the structured-output contract (docs/ai/validation.md §1).
 * One definition, two consumers:
 *  - `GENERATED_CONTENT_JSON_SCHEMA` goes to the provider (structured output);
 *  - `generatedContentSchema` re-validates whatever comes back (stage 1).
 * Providers are untrusted: schema-on-send never replaces schema-on-receive.
 */

import { z } from "zod";
import { CLAIM_FIELDS, HASHTAG_MAX, HASHTAG_MIN, type CaptionContent } from "@/core/domain/caption";

export const claimSchema = z.object({
  field: z.enum(CLAIM_FIELDS),
  statement: z.string().trim().min(1),
  sourceText: z.string().trim().min(1),
});

export const generatedContentSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  hashtags: z.array(z.string().trim().min(2)).min(HASHTAG_MIN).max(HASHTAG_MAX),
  claims: z.array(claimSchema),
  confidence: z.number().min(0).max(1).optional(),
});

export type GeneratedContent = z.infer<typeof generatedContentSchema>;

/** Compile-time proof the AI contract and the caption domain stay in sync. */
const _contentShapeMatchesDomain: (value: GeneratedContent) => CaptionContent = (value) => value;
void _contentShapeMatchesDomain;

/**
 * JSON Schema sent to providers. Kept to the subset both Gemini
 * (`responseJsonSchema`) and OpenAI (`text.format`) accept; each adapter may
 * narrow it further for its own dialect.
 *
 * `confidence` is REQUIRED here (OpenAI strict mode requires every property in
 * `required`) but optional in the zod schema — a model omitting it is a quality
 * signal, not a reason to throw away an otherwise valid caption.
 */
export const GENERATED_CONTENT_SCHEMA_NAME = "generated_content";

export const GENERATED_CONTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "hashtags", "claims", "confidence"],
  properties: {
    title: {
      type: "string",
      description:
        "TIÊU ĐỀ CẢM XÚC VIẾT HOA, KHÔNG chứa tên sản phẩm (hệ thống tự ghép tên vào dòng đầu).",
    },
    body: {
      type: "string",
      description: "Nội dung caption tiếng Việt, không chứa giá, tồn kho hay ghi chú sản xuất.",
    },
    hashtags: {
      type: "array",
      minItems: HASHTAG_MIN,
      maxItems: HASHTAG_MAX,
      items: { type: "string", description: "Hashtag bắt đầu bằng #, không dấu cách." },
    },
    claims: {
      type: "array",
      description: "Mọi khẳng định factual đã dùng, kèm đoạn nguồn nguyên văn.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "statement", "sourceText"],
        properties: {
          field: { type: "string", enum: [...CLAIM_FIELDS] },
          statement: { type: "string" },
          sourceText: {
            type: "string",
            description: "Trích nguyên văn từ Mô tả sản phẩm / Chủng loại / Mùa vụ.",
          },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const satisfies Readonly<Record<string, unknown>>;
