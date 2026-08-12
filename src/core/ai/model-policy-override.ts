/**
 * Schema for the per-tenant registry override stored in
 * `ai_model_policy_override.override` (ADR-001, model-routing.md §2).
 *
 * A jsonb blob is external data like a Sheet row: hand-edited, older writes,
 * possibly wrong. It is parsed here — at the boundary — so a bad override fails
 * with a named field instead of routing a generation to `undefined`.
 *
 * Note what is NOT parseable: a model STRING. `tierModels` holds registry keys
 * only, and `applyPolicyOverride` refuses any key absent from the YAML file.
 */

import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import { AI_TIERS, type AITask, type ModelPolicyOverride } from "@/core/ports/ai";

export const modelPolicyOverrideSchema = z
  .object({
    vision: z.enum(["none", "single", "multi"]).optional(),
    primary: z.enum(AI_TIERS).optional(),
    escalate: z.array(z.enum(AI_TIERS)).optional(),
    maxEscalations: z.number().int().min(0).max(3).optional(),
    maxOutputTokens: z.number().int().positive().max(32_000).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    tierModels: z.partialRecord(z.enum(AI_TIERS), z.array(z.string().min(1)).min(1)).optional(),
    budget: z
      .object({
        maxCostPerGenerationUsd: z.number().positive().optional(),
        dailyCostPerTenantUsd: z.number().positive().optional(),
      })
      .optional(),
  })
  // Unknown keys are rejected, not ignored: a typo like `maxEscalation` would
  // otherwise look applied while the real value never changed.
  .strict();

export function parseModelPolicyOverride(
  raw: unknown,
  context: { tenantId: string; task: AITask },
): ModelPolicyOverride {
  const parsed = modelPolicyOverrideSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }));

  throw new AppError("MODEL_NOT_CONFIGURED", {
    message: `Stored model policy override for task "${context.task}" is invalid: ${issues
      .map((issue) => issue.path)
      .join(", ")}`,
    userMessage: "Cấu hình model riêng của đơn vị không hợp lệ — cần quản trị viên sửa lại.",
    context: { tenant_id: context.tenantId, task: context.task, issues },
  });
}
