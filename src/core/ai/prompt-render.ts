/**
 * Prompt rendering — pure `{{var}}` substitution over an immutable template
 * (docs/ai/prompt-versioning.md §1). Editing a prompt means shipping a new
 * version; nothing here mutates a template.
 */

import { AppError } from "@/core/domain/errors";
import type { AITask, PromptTemplate } from "@/core/ports/ai";

/** A generation template that lacks these cannot be activated (prompt-versioning.md §1). */
export const REQUIRED_PROMPT_VARIABLES = ["product.name", "constraints"] as const;

/**
 * The ONLY variables a template may reference (CLAUDE.md business rule 2).
 *
 * This is the prompt-side half of the whitelist wall: `buildPromptVariables`
 * produces exactly these keys, so a template asking for anything else — say
 * `{{product.price}}` or `{{product.stock}}` — is rejected at SAVE time instead
 * of exploding (or worse, rendering something) at 2am during a generation.
 */
export const PROMPT_VARIABLE_WHITELIST = [
  "product.name",
  "product.description",
  "product.category",
  "product.season",
  "constraints",
  "platform",
  "contentType",
  "language",
  "brandVoice",
  "otherCaptions",
  "previousFailures",
] as const;

export type PromptVariableName = (typeof PROMPT_VARIABLE_WHITELIST)[number];

/**
 * Per-task required variables. A task whose prompt cannot see the product name
 * cannot produce content that passes validation stage 2, so this is a hard gate.
 */
const REQUIRED_BY_TASK: Readonly<Record<AITask, readonly string[]>> = {
  facebook_content: REQUIRED_PROMPT_VARIABLES,
  difficult_content: REQUIRED_PROMPT_VARIABLES,
  product_understanding: ["product.name"],
  caption_dedupe_check: ["otherCaptions"],
};

/**
 * Whitelisted variables whose absence is a WARNING, not an error: the template
 * still renders, but a documented capability silently stops working.
 */
const RECOMMENDED_BY_TASK: Readonly<Record<AITask, readonly string[]>> = {
  facebook_content: ["product.description", "otherCaptions", "previousFailures"],
  difficult_content: ["product.description", "previousFailures"],
  product_understanding: ["product.description"],
  caption_dedupe_check: [],
};

export function requiredVariablesFor(task: AITask): readonly string[] {
  return REQUIRED_BY_TASK[task] ?? REQUIRED_PROMPT_VARIABLES;
}

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/gu;

export type PromptVariables = Readonly<Record<string, string>>;

export function extractVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map((match) => match[1]))];
}

export interface TemplateBodyReport {
  variables: string[];
  /** Required by the task and absent — blocks saving. */
  missing: string[];
  /** Outside the whitelist — blocks saving (it would fail to render anyway). */
  unknown: string[];
  /** Whitelisted, recommended, absent — returned to the caller as a warning. */
  warnings: string[];
}

/**
 * Pure check of a template body before it is stored. Never throws: the caller
 * decides what to do with each class of problem (the usecase turns `missing`
 * and `unknown` into INVALID_INPUT and passes `warnings` back to the UI).
 */
export function inspectTemplateBody(body: string, task: AITask): TemplateBodyReport {
  const variables = extractVariables(typeof body === "string" ? body : "");
  const present = new Set(variables);
  const allowed = new Set<string>(PROMPT_VARIABLE_WHITELIST);

  return {
    variables,
    missing: requiredVariablesFor(task).filter((name) => !present.has(name)),
    unknown: variables.filter((name) => !allowed.has(name)),
    warnings: (RECOMMENDED_BY_TASK[task] ?? [])
      .filter((name) => !present.has(name))
      .map((name) => `Template không dùng biến "${name}" — bỏ qua dữ liệu này khi sinh nội dung.`),
  };
}

/**
 * Enforced when a template is stored/loaded, not at generation time — a broken
 * template must never become `active`.
 */
export function assertTemplateValid(template: PromptTemplate): void {
  const report = inspectTemplateBody(template.userPromptTemplate, template.task);
  if (report.missing.length === 0 && report.unknown.length === 0) return;

  const problems = [
    report.missing.length > 0 ? `missing: ${report.missing.join(", ")}` : "",
    report.unknown.length > 0 ? `not whitelisted: ${report.unknown.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  throw new AppError("INVALID_INPUT", {
    message: `Prompt template "${template.id}" v${template.version} has invalid variables (${problems})`,
    userMessage:
      report.missing.length > 0
        ? "Mẫu prompt thiếu biến bắt buộc — không thể dùng để sinh nội dung."
        : "Mẫu prompt dùng biến không nằm trong danh sách cho phép.",
    context: {
      prompt_template_id: template.id,
      prompt_version: template.version,
      task: template.task,
      missing_variables: report.missing,
      unknown_variables: report.unknown,
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
