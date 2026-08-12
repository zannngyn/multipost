import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";

/** Mirrors TENANT_STATUSES in core/domain/tenant.ts — keep both in sync. */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended"]);

/**
 * Tenant root table. It is the only business table WITHOUT a `tenant_id`
 * column — its own `id` is the discriminator (see tenant-scope.ts `whereSelf`).
 */
export const tenants = pgTable("tenant", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: tenantStatusEnum("status").notNull().default("active"),
  ...timestamps,
});

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
