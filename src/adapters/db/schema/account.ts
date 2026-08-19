import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";

/** Mirrors ACCOUNT_STATUSES in core/domain/account.ts — keep both in sync. */
export const accountStatusEnum = pgEnum("account_status", ["active", "suspended"]);

/**
 * MYSP-staff privileges, held by the PERSON and not by any tenant (docs/09 §3.5).
 * Null is the normal case: a customer operator has no platform role at all.
 * `support` may enter a tenant through a support session (read only, doc 10 §8.1);
 * `super_admin` may also create/suspend tenants and grant platform roles.
 */
export const platformRoleEnum = pgEnum("platform_role", ["support", "super_admin"]);

/**
 * A PERSON (docs/09 §3.1). Second and last table without a `tenant_id`, for the
 * same structural reason as `tenant`: it sits ABOVE the tenant boundary. One
 * person may hold memberships in several companies (Q1), so filing them under one
 * tenant would either duplicate the human or pin them to whichever company they
 * joined first. Authorization never reads this table alone — it reads
 * `membership`, which IS tenant-scoped.
 *
 * `status='suspended'` is a platform-level ban: it blocks sign-in everywhere,
 * regardless of membership. Losing access to ONE company is `membership.status`.
 */
export const accounts = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: accountStatusEnum("status").notNull().default("active"),
  /** Null = ordinary customer operator. Bootstrapped from env once, then DB-managed. */
  platformRole: platformRoleEnum("platform_role"),
  /** What the provider told us the person is called; Facebook may tell us nothing. */
  displayName: text("display_name"),
  ...timestamps,
});

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
