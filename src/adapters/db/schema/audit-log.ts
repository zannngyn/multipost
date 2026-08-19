import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { actorKindEnum } from "./_actor-kind";
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
    /**
     * What KIND of actor wrote this row (doc 10 §5). Without it, a reaper's row
     * and a row whose operator could not be resolved are both just
     * `actor_user_id IS NULL` and nobody can tell them apart afterwards.
     *
     * NULLABLE rather than `NOT NULL DEFAULT 'user'`: rows written before M1.1
     * carry no evidence of their actor, and defaulting them to `user` would put
     * a claim in an append-only trail that we cannot support — the worker's rows
     * would be labelled as people. The backfill only fills in what the data
     * proves (`actor_user_id IS NOT NULL` ⇒ `user`) and leaves the rest NULL,
     * which reads as "not recorded". Writers from M1.3 always set it; the column
     * cannot become NOT NULL later because history stays unknowable.
     */
    actorKind: actorKindEnum("actor_kind"),
    /**
     * Which worker/job wrote it, e.g. 'publish-post', 'reap-post-jobs'. Only
     * meaningful when `actor_kind='system'`; null otherwise.
     */
    systemComponent: text("system_component"),
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
