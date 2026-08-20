import { pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { accounts } from "./account";

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
    /**
     * The person behind this domain actor (docs/09 §3.2). NULLABLE because rows
     * that predate M1.1 may have no identity to link to — an operator created by
     * the env bootstrap never went through the registry.
     *
     * The invariant is *one ACTIVE membership ↔ one app_user, per tenant*. The
     * transaction that creates a membership also upserts this row (from M1.2/M2,
     * same shape as `access-request-repo.decide`); what the DB guarantees is the
     * other half — the UNIQUE below makes a second `app_user` for the same person
     * in the same tenant impossible, so "code will keep them in step" is not the
     * only thing standing between us and two audit subjects for one human.
     * Postgres treats NULLs as distinct in a unique index, so the unlinked legacy
     * rows do not collide with each other.
     */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull().default("editor"),
    ...timestamps,
  },
  (table) => [
    // Email is unique PER TENANT, not globally: the same person may operate two
    // tenants. Doubles as the tenant_id index (leftmost prefix).
    unique("app_user_tenant_email_uq").on(table.tenantId, table.email),
    unique("app_user_tenant_account_uq").on(table.tenantId, table.accountId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
