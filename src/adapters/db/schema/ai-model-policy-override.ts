import { jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Per-tenant registry override (ADR-001: "Registry = YAML-trong-repo + DB
 * override theo tenant", model-routing.md §2). Lets an operator change routing
 * for ONE tenant without a deploy.
 *
 * The blob is parsed through a zod schema in the AI adapter before use, and the
 * merge (core/ai/model-policy.ts) only accepts model KEYS that already exist in
 * `config/ai-models.yaml`: a DB row can re-order or restrict providers, it can
 * never introduce a model string that no PR reviewed.
 *
 * Shape (all fields optional):
 *   { vision, primary, escalate[], maxEscalations, maxOutputTokens, timeoutMs,
 *     temperature, tierModels: { cheap: ["google:..."], ... },
 *     budget: { maxCostPerGenerationUsd, dailyCostPerTenantUsd } }
 */
export const aiModelPolicyOverrides = pgTable(
  "ai_model_policy_override",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    task: text("task").notNull(),
    override: jsonb("override").$type<Record<string, unknown>>().notNull(),
    /** Why this tenant deviates — read during incident review. */
    note: text("note"),
    ...timestamps,
  },
  (table) => [unique("ai_model_policy_override_task_uq").on(table.tenantId, table.task)],
);

export type AiModelPolicyOverrideRow = typeof aiModelPolicyOverrides.$inferSelect;
export type NewAiModelPolicyOverrideRow = typeof aiModelPolicyOverrides.$inferInsert;
