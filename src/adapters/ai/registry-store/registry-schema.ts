/**
 * Schema for `config/ai-models.yaml` (docs/ai/model-routing.md §2).
 * The registry is external data like any other: parsed, never trusted.
 * A malformed registry must fail fast at load time, not at 2am mid-generation.
 */

import { z } from "zod";
import { AI_PROVIDERS, AI_TASKS, AI_TIERS } from "@/core/ports/ai";

const pricingSchema = z.object({
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
  cachedInputPerMTokUsd: z.number().nonnegative().optional(),
});

const capabilitiesSchema = z.object({
  vision: z.boolean(),
  structuredOutput: z.boolean(),
  maxOutputTokens: z.number().int().positive(),
  /**
   * Defaults to true: accepting a temperature is the norm, and an older registry
   * that predates this field must keep behaving exactly as it did. A model that
   * rejects the parameter (GPT-5 family) has to say so explicitly.
   */
  temperature: z.boolean().default(true),
});

const modelSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  model: z.string().min(1),
  pricing: pricingSchema,
  capabilities: capabilitiesSchema,
});

const taskSchema = z.object({
  vision: z.enum(["none", "single", "multi"]),
  primary: z.enum(AI_TIERS),
  escalate: z.array(z.enum(AI_TIERS)).default([]),
  maxEscalations: z.number().int().min(0).max(3),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
});

export const registrySchema = z.object({
  version: z.number().int().positive(),
  models: z.record(z.string().min(1), modelSchema),
  // partialRecord, not record: a registry may declare only the tiers/tasks it
  // uses. Missing-but-referenced entries are caught by the consistency pass.
  tiers: z.partialRecord(z.enum(AI_TIERS), z.array(z.string().min(1)).min(1)),
  tasks: z.partialRecord(z.enum(AI_TASKS), taskSchema),
  budget: z.object({
    maxCostPerGenerationUsd: z.number().positive(),
    dailyCostPerTenantUsd: z.number().positive(),
  }),
});

export type RegistryFile = z.infer<typeof registrySchema>;

/** Cross-field checks zod cannot express on its own. Returns human-readable problems. */
export function findRegistryInconsistencies(registry: RegistryFile): string[] {
  const problems: string[] = [];

  for (const [tier, keys] of Object.entries(registry.tiers)) {
    for (const key of keys ?? []) {
      if (!registry.models[key]) {
        problems.push(`tier "${tier}" references unknown model "${key}"`);
      }
    }
  }

  for (const [task, policy] of Object.entries(registry.tasks)) {
    if (!policy) continue;
    const referencedTiers = [policy.primary, ...policy.escalate];
    for (const tier of referencedTiers) {
      const models = registry.tiers[tier];
      if (!models || models.length === 0) {
        problems.push(`task "${task}" references empty tier "${tier}"`);
      }
    }
    if (policy.escalate.length < policy.maxEscalations) {
      problems.push(
        `task "${task}" allows ${policy.maxEscalations} escalations but lists ${policy.escalate.length} tier(s)`,
      );
    }
  }

  return problems;
}
