import { index, integer, pgEnum, pgTable, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { accounts } from "./account";
import { userRoleEnum } from "./user";

/**
 * `removed` instead of deleting the row: the audit trail refers to it, and a
 * re-invite must land on the SAME row (UNIQUE below) rather than silently
 * creating a second membership with a stale `version`.
 */
export const membershipStatusEnum = pgEnum("membership_status", ["active", "removed"]);

/**
 * AUTHORIZATION: person ↔ company ↔ role (docs/09 §3.1–3.2). This table — never
 * a cookie, never a JWT claim — decides what a request may do inside a tenant.
 *
 * `version` is what makes a revoke effective ACROSS PROCESSES (docs/09 §3.4):
 * an in-memory `invalidateAll()` in the web container cannot reach the worker.
 * Every role change / removal bumps it; tier-S checks read the row fresh and
 * tier-R/M compare the cached version against it.
 */
export const memberships = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
    status: membershipStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    /**
     * Who let this person in. Null for backfilled rows and for the founder of a
     * self-service tenant, who was let in by nobody. `set null` keeps the row
     * readable after the inviter's account is deleted.
     */
    invitedByAccountId: uuid("invited_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    // One membership per (company, person) — an invite accepted twice must be a
    // no-op at the DB level, not a duplicate row with a different role.
    // Doubles as the tenant_id index (leftmost prefix).
    unique("membership_tenant_account_uq").on(table.tenantId, table.accountId),
    // THE per-request lookup from M1.2: "which companies does this person have,
    // and which one does the active-tenant cookie point at". The unique above
    // cannot serve it — its leftmost column is the tenant, not the account.
    index("membership_account_status_idx").on(table.accountId, table.status),
  ],
);

export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;
