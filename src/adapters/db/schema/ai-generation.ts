import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { actorKindEnum } from "./_actor-kind";
import { tenantIdColumn } from "./_tenant-column";
import { users } from "./user";

/**
 * ONE ROW PER ATTEMPT — including every failed one (docs/ai/prompt-versioning.md
 * §2, ADR-001 nguyên tắc #8/#9). An escalation writes a second row, a provider
 * fallback writes a second row, a timeout writes a row with zero tokens.
 *
 * Append-only: nothing updates a generation row, so there is no `updated_at`.
 *
 * The questions this table must answer without a debugger (§3):
 *   - why did THIS caption fail?           -> status + failure_kind + validation_stage_failed
 *   - which model is best/cheapest?        -> group by model: cost_usd, status
 *   - is prompt v2 better than v1?         -> group by prompt_version
 *   - which provider is flaky?             -> fallback_used by provider by hour
 *   - what does a published post cost?     -> sum(cost_usd) by post_job_id
 */
export const aiGenerationStatusEnum = pgEnum("ai_generation_status", [
  /** API call ok AND all four validation stages passed. */
  "passed",
  /** API call ok, output rejected by validation (quality road -> escalation). */
  "validation_failed",
  /** The call itself failed (infra road -> provider fallback), or was refused. */
  "provider_error",
]);

export const aiGenerations = pgTable(
  "ai_generation",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    /** Groups the attempts of ONE `ContentEngine.generate` call. */
    generationId: text("generation_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    /** Trace id across HTTP request / job, when the caller has one. */
    requestId: text("request_id"),
    task: text("task").notNull(),
    tier: text("tier").notNull(),
    provider: text("provider").notNull(),
    /** Model actually used AFTER routing — never a business-code constant. */
    model: text("model").notNull(),
    promptTemplateId: text("prompt_template_id").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    status: aiGenerationStatusEnum("status").notNull(),
    /** timeout | rate_limited | provider_down | content_refused | bad_request | malformed_output */
    failureKind: text("failure_kind"),
    errorCode: text("error_code"),
    /** 1 schema · 2 business · 3 claim · 4 content policy (docs/ai/validation.md). */
    validationStageFailed: integer("validation_stage_failed"),
    /** Provider swapped because of an INFRA failure — never because of quality. */
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    /** Attempt number this one escalated from; null on the first attempt. */
    escalationFrom: integer("escalation_from"),
    inputHash: text("input_hash").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Priced from the registry table at call time (docs/ai/cost-model.md §1). */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    validationFailures: jsonb("validation_failures").$type<
      Array<{ stage: number; rule: string; message: string }>
    >(),
    /** GeneratedContent kept for eval/debug; a retention job trims it later. */
    output: jsonb("output"),
    /**
     * WHO spent this money (doc 10 §8.9). Spend is charged to the tenant's plan,
     * so the tenant column already answers billing; this pair answers the two
     * questions billing cannot: "which operator burned the daily allowance" and
     * "was this a person at all, or a background job".
     *
     * Two columns rather than one because `created_by_user_id IS NULL` is
     * ambiguous on its own — worker, or an operator we failed to resolve. Both
     * are nullable and `actor_kind` has no default: rows written before M1.1
     * genuinely do not know, and a default would state otherwise. A real FK (not
     * the loose text ids this table uses for post/batch/channel) because
     * `app_user` is a small table in the same database and the join is the whole
     * point of the column; `set null` keeps the cost row after the operator goes.
     */
    actorKind: actorKindEnum("actor_kind"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Business context — nullable: a caption is written BEFORE the job exists. */
    postJobId: text("post_job_id"),
    batchId: text("batch_id"),
    productCode: text("product_code"),
    channelId: text("channel_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Cost/day per tenant + the dashboard's time series (cost-model.md §3).
    index("ai_generation_tenant_created_idx").on(table.tenantId, table.createdAt),
    // "Show me every attempt of this generation, in order."
    index("ai_generation_tenant_generation_idx").on(table.tenantId, table.generationId),
    index("ai_generation_tenant_job_idx").on(table.tenantId, table.postJobId),
  ],
);

export type AiGenerationRow = typeof aiGenerations.$inferSelect;
export type NewAiGenerationRow = typeof aiGenerations.$inferInsert;
