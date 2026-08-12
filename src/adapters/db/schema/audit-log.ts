import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./_tenant-column";
import { users } from "./user";

/**
 * Append-only trail answering "who changed what, when" per tenant.
 * No `updated_at`: rows are never modified.
 */
export const auditLogs = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    /** Null for system/worker actions with no human actor. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Verb, e.g. 'tenant.integration.updated', 'post_job.published'. */
    action: text("action").notNull(),
    /** Entity kind, e.g. 'tenant_integration', 'post_job'. */
    entityType: text("entity_type").notNull(),
    /** Null for actions not bound to one row (e.g. 'auth.login'). */
    entityId: text("entity_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  // Reads are always "latest events of one tenant" — index matches that shape.
  (table) => [index("audit_log_tenant_created_at_idx").on(table.tenantId, table.createdAt)],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
