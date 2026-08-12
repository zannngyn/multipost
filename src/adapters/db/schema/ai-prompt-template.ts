import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Versioned prompt templates (docs/ai/prompt-versioning.md §1).
 *
 * IMMUTABLE ROWS: nothing here is ever updated except `is_active`. Editing a
 * prompt means inserting the next version, so a generation logged two months
 * ago still resolves to the exact words that produced it.
 *
 * Two constraints carry the invariants:
 *   ai_prompt_template_version_uq — (tenant, task, version) is unique, so two
 *     concurrent "create version" calls cannot both take v3.
 *   ai_prompt_template_active_uq  — PARTIAL unique index over the active rows
 *     only: at most ONE active version per (tenant, task, platform). Enforced by
 *     Postgres, not by application ordering.
 *
 * A tenant with no row here runs the built-in template from code; nothing is
 * seeded per tenant (see core/usecases/manage-prompt-templates.ts).
 */
export const aiPromptTemplates = pgTable(
  "ai_prompt_template",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(),
    task: text("task").notNull(),
    platform: text("platform").notNull(),
    /** Operator-facing label of this version. */
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    /** User prompt template, `{{variable}}` placeholders included. */
    body: text("body").notNull(),
    /** Variable names found in `body` at save time — UI hint + audit trail. */
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    version: integer("version").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    /** Why this version exists. Required by the usecase. */
    changelog: text("changelog").notNull().default(""),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (table) => [
    unique("ai_prompt_template_version_uq").on(table.tenantId, table.task, table.version),
    uniqueIndex("ai_prompt_template_active_uq")
      .on(table.tenantId, table.task, table.platform)
      .where(sql`${table.isActive}`),
    index("ai_prompt_template_tenant_task_idx").on(table.tenantId, table.task, table.platform),
  ],
);

export type AiPromptTemplateRow = typeof aiPromptTemplates.$inferSelect;
export type NewAiPromptTemplateRow = typeof aiPromptTemplates.$inferInsert;
