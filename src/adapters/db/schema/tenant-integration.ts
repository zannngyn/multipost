import { jsonb, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

export const integrationStatusEnum = pgEnum("integration_status", [
  "active",
  "disabled",
  /** Credentials rejected / token expired — operator action needed. */
  "error",
]);

/**
 * Per-tenant configuration of an external provider (Drive/Sheet, Meta, ...).
 * `provider` stays free-form text on purpose: adding TikTok must not require a
 * DB enum migration. Known values today: 'google', 'meta'.
 *
 * `config` holds provider settings (folder id, sheet id, page id...). Secrets
 * belong in a dedicated encrypted column/vault — do NOT put raw tokens here.
 */
export const tenantIntegrations = pgTable(
  "tenant_integration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    provider: text("provider").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: integrationStatusEnum("status").notNull().default("active"),
    ...timestamps,
  },
  // The composite unique also serves as the tenant_id index (B-tree leftmost
  // prefix) — a standalone tenant_id index would be pure duplication.
  (table) => [unique("tenant_integration_tenant_provider_uq").on(table.tenantId, table.provider)],
);

export type TenantIntegrationRow = typeof tenantIntegrations.$inferSelect;
export type NewTenantIntegrationRow = typeof tenantIntegrations.$inferInsert;
