/**
 * Stage 1 — SCHEMA (docs/ai/validation.md §2).
 * The model's output is external data: parse it, never trust it.
 * Failures report the JSON path + zod code ONLY — raw output never leaks into
 * an error message or a log line at this stage.
 */

import { generatedContentSchema, type GeneratedContent } from "@/core/ai/generated-content";
import { failure, type ValidationFailure } from "@/core/ai/validation/types";

export interface SchemaValidationResult {
  ok: boolean;
  content?: GeneratedContent;
  failures: ValidationFailure[];
}

export function validateSchema(output: unknown): SchemaValidationResult {
  // Guard: providers can return null/undefined/string when a call half-fails.
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return {
      ok: false,
      failures: [
        failure(1, "schema.not_object", "Kết quả AI không phải một đối tượng JSON hợp lệ.", {
          received_type: Array.isArray(output) ? "array" : typeof output,
        }),
      ],
    };
  }

  const parsed = generatedContentSchema.safeParse(output);
  if (parsed.success) return { ok: true, content: parsed.data, failures: [] };

  const failures = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return failure(1, `schema.${issue.code}`, `Trường "${path}" không đúng định dạng yêu cầu.`, {
      path,
      code: issue.code,
    });
  });

  return { ok: false, failures };
}
