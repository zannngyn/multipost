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

/**
 * C0 controls that must never appear in generated copy. NUL is the one that
 * bites: it is legal in a JSON string but Postgres refuses it in text/jsonb
 * ("unsupported Unicode escape sequence"), so an attempt carrying it cannot even
 * be written to `ai_generation`. Tab, newline and carriage return stay legal —
 * real copy uses them. DEL and C1 are left alone too: Postgres accepts them, and
 * stage 2/4 own what the text may actually say.
 *
 * Observed live on 15/08/2026: gpt-4.1-mini answered with mojibake full of NUL
 * and other C0 controls. The old pipeline let it through stage 1, failed it
 * at stage 3 with a confusing "source not found", then lost the audit row.
 */
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

function findControlCharacter(value: unknown, path: string): string | null {
  if (typeof value === "string") return FORBIDDEN_CONTROL_CHARS.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findControlCharacter(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const found = findControlCharacter(item, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
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

  // Before zod: a control character makes the payload unusable no matter which
  // field it lands in, and the caller should escalate, not puzzle over stage 3.
  const controlPath = findControlCharacter(output, "");
  if (controlPath !== null) {
    return {
      ok: false,
      failures: [
        failure(
          1,
          "schema.control_characters",
          "Kết quả AI chứa ký tự điều khiển không hợp lệ — nội dung bị hỏng, cần sinh lại.",
          { path: controlPath },
        ),
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
