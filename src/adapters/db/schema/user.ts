import { pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/** Provisional role set — refine when the auth epic lands. */
export const userRoleEnum = pgEnum("user_role", ["owner", "admin", "editor", "viewer"]);

/**
 * Operator account. Physical table is `app_user`: `user` is a reserved word in
 * Postgres, so an unquoted `select ... from user` would silently mean
 * `current_user` in psql. Drizzle would quote it, humans debugging would not.
 *
 * `email` is stored lower-cased by the writer (see seed.ts) — Postgres text is
 * case-sensitive, so the unique index only holds if callers normalise.
 */
export const users = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull().default("editor"),
    ...timestamps,
  },
  // Email is unique PER TENANT, not globally: the same person may operate two
  // tenants. Doubles as the tenant_id index (leftmost prefix).
  (table) => [unique("app_user_tenant_email_uq").on(table.tenantId, table.email)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
