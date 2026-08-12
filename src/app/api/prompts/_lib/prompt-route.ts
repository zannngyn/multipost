import { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Shared boundary pieces of `/api/prompts/**` (E10.7). Kept here so the three
 * route files stay thin (docs/07 §3.3) and cannot drift apart on the target
 * (tenant + task + platform) they all validate the same way.
 */

/**
 * Mirrors `AI_TASKS` in core/ports/ai.ts. The app layer may only import error
 * codes from core (ESLint zone rule), so the list is repeated — a task added
 * there and forgotten here fails validation loudly instead of silently.
 */
const AI_TASKS = [
  "facebook_content",
  "product_understanding",
  "caption_dedupe_check",
  "difficult_content",
] as const;

/** Phase 1 screen only edits the Facebook caption prompt. */
export const DEFAULT_TASK = "facebook_content";
export const DEFAULT_PLATFORM = "facebook";

export const TargetSchema = z.object({
  tenantId: z
    .string({ error: "Thiếu mã đơn vị (tenant)." })
    .trim()
    .min(1, "Thiếu mã đơn vị (tenant)."),
  task: z.enum(AI_TASKS).default(DEFAULT_TASK),
  platform: z.string().trim().min(1, "Thiếu nền tảng.").max(64).default(DEFAULT_PLATFORM),
});

export type PromptTarget = z.infer<typeof TargetSchema>;

/** Parses `?tenantId=&task=&platform=` into the usecase target. */
export function readTarget(request: Request, route: string): PromptTarget {
  const params = new URL(request.url).searchParams;
  const parsed = TargetSchema.safeParse({
    tenantId: params.get("tenantId") ?? undefined,
    task: params.get("task") ?? undefined,
    platform: params.get("platform") ?? undefined,
  });

  if (!parsed.success) {
    throw new AppError("INVALID_INPUT", {
      message: `Invalid query string for ${route}`,
      userMessage: "Tham số không hợp lệ. Vui lòng kiểm tra lại mã đơn vị (tenant) và tác vụ.",
      context: {
        route,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      },
    });
  }

  return parsed.data;
}

/**
 * Re-shapes the variable refusal of `manage-prompt-templates` so the form can
 * render it next to the body field.
 *
 * The usecase already produces the Vietnamese sentence AND the variable names,
 * but it puts the names in `context.missing_variables` / `unknown_variables`,
 * which `mapAppErrorToHttp` does not forward. This copies them into the `issues`
 * channel the UI already understands. No decision is taken here — the code, the
 * status and the operator sentence are the usecase's, unchanged.
 */
export function withVariableIssues(error: unknown): unknown {
  if (!AppError.is(error) || error.code !== "INVALID_INPUT") return error;

  const context = error.context as {
    missing_variables?: unknown;
    unknown_variables?: unknown;
    issues?: unknown;
  };
  if (Array.isArray(context.issues)) return error;

  const missing = stringList(context.missing_variables);
  const unknown = stringList(context.unknown_variables);
  if (missing.length === 0 && unknown.length === 0) return error;

  const issues = [
    ...missing.map((name) => ({
      path: "body",
      message: `Thiếu biến bắt buộc {{${name}}} trong nội dung prompt.`,
    })),
    ...unknown.map((name) => ({
      path: "body",
      message: `Biến {{${name}}} không nằm trong danh sách cho phép — bỏ biến này đi.`,
    })),
  ];

  return new AppError(error.code, {
    message: error.message,
    userMessage: error.userMessage,
    context: { ...error.context, issues },
    cause: error,
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
