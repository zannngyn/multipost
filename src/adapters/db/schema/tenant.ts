import { pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { accounts } from "./account";

/** Mirrors TENANT_STATUSES in core/domain/tenant.ts — keep both in sync. */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended"]);

/**
 * Subscription plan (doc 10 §8.9). Every consumption ceiling — AI spend per day,
 * quotas — hangs off this column, never off an env var: an env ceiling is one
 * number for every customer on the box. `internal` is MYSP's own tenant and has
 * no ceiling; `standard` is the default for customers. Billing itself is out of
 * scope, the column is not.
 */
export const tenantPlanEnum = pgEnum("tenant_plan", ["internal", "standard"]);

/**
 * Tenant root table. Together with `account` it is one of the two tables WITHOUT
 * a `tenant_id` column — its own `id` is the discriminator (see tenant-scope.ts
 * `whereSelf`).
 */
export const tenants = pgTable(
  "tenant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: tenantStatusEnum("status").notNull().default("active"),
    /**
     * Human-readable handle for URLs and support ("công ty `demo`"). NULLABLE on
     * purpose: rows created before M1.1 have none and inventing one from `name`
     * would mint a URL nobody chose. Self-service tenant creation (M2.1) fills it
     * in; a later migration can tighten this once every row has one.
     */
    slug: text("slug"),
    /**
     * Who created the company (docs/09 §3.7 — the anti-abuse counter groups by
     * it). Null for the seeded tenant and for anything created before M1.1.
     */
    createdByAccountId: uuid("created_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    plan: tenantPlanEnum("plan").notNull().default("standard"),
    ...timestamps,
  },
  (table) => [unique("tenant_slug_uq").on(table.slug)],
);

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
