/**
 * Prompt rendering — pure `{{var}}` substitution over an immutable template
 * (docs/ai/prompt-versioning.md §1). Editing a prompt means shipping a new
 * version; nothing here mutates a template.
 */

import { AppError } from "@/core/domain/errors";
import type { PromptTemplate } from "@/core/ports/ai";

/** A generation template that lacks these cannot be activated (prompt-versioning.md §1). */
export const REQUIRED_PROMPT_VARIABLES = ["product.name", "constraints"] as const;

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/gu;

export type PromptVariables = Readonly<Record<string, string>>;

export function extractVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map((match) => match[1]))];
}

/**
 * Enforced when a template is stored/loaded, not at generation time — a broken
 * template must never become `active`.
 */
export function assertTemplateValid(template: PromptTemplate): void {
  const present = new Set(extractVariables(template.userPromptTemplate));
  const missing = REQUIRED_PROMPT_VARIABLES.filter((name) => !present.has(name));
  if (missing.length === 0) return;

  throw new AppError("INVALID_INPUT", {
    message: `Prompt template "${template.id}" v${template.version} misses required variables: ${missing.join(", ")}`,
    userMessage: "Mẫu prompt thiếu biến bắt buộc — không thể dùng để sinh nội dung.",
    context: {
      prompt_template_id: template.id,
      prompt_version: template.version,
      missing_variables: missing,
    },
  });
}

/**
 * Substitute variables. An unknown/undefined variable is a bug in the caller,
 * not a reason to publish a prompt containing a literal "{{...}}".
 */
export function renderPrompt(template: string, variables: PromptVariables): string {
  const missing: string[] = [];
  const rendered = template.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.push(name);
      return "";
    }
    return value;
  });

  if (missing.length > 0) {
    throw new AppError("INVALID_INPUT", {
      message: `Prompt rendering missed variables: ${[...new Set(missing)].join(", ")}`,
      userMessage: "Thiếu dữ liệu bắt buộc để dựng prompt cho AI.",
      context: { missing_variables: [...new Set(missing)] },
    });
  }

  return rendered;
}
