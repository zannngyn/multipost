import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { users, userRoleEnum } from "./user";

export const accessProviderEnum = pgEnum("access_provider", ["google", "facebook"]);
export const accessStatusEnum = pgEnum("access_status", ["pending", "approved", "blocked"]);

/**
 * Who may sign in (E1.4). One row per PROVIDER IDENTITY, created by the first
 * sign-in attempt and decided by an admin afterwards.
 *
 * WHY IT IS NOT `app_user`:
 * - `app_user.email` is NOT NULL, and Facebook does not guarantee an address;
 * - an identity is `(provider, provider_account_id)`, not an e-mail — matching
 *   across providers by e-mail is the account-linking hijack the sign-in gate
 *   exists to prevent;
 * - `app_user` is the AUDIT subject (drafts, `audit_log.actor_user_id`), and a
 *   rejected stranger must not become one. An approval creates the `app_user`
 *   row; a pending or blocked request never does.
 *
 * TENANT (PENDING(tenant-mapping)): a first sign-in cannot say which tenant the
 * person belongs to — nothing has asked them yet. The row is therefore filed
 * under the deployment's default tenant (the seeded one, as the Facebook
 * channel import already does), and moving an approved operator to another
 * tenant is a Phase-2 decision. `tenant_id` stays NOT NULL so `forTenant()`
 * keeps working: a nullable discriminator would put a hole in every query.
 */
export const accessRequests = pgTable(
  "access_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    provider: accessProviderEnum("provider").notNull(),
    /** App-scoped for Facebook, `sub` for Google. Stable per provider + app. */
    providerAccountId: text("provider_account_id").notNull(),
    /**
     * The address this identity's JWT session carries — synthetic for Facebook
     * (`fb-<id>@facebook.local`, see shared/operator-access). Lower-cased by the
     * writer: Postgres text is case-sensitive and the unique index below only
     * holds if callers normalise.
     */
    sessionEmail: text("session_email").notNull(),
    /** What the provider actually returned. Null is normal for Facebook. */
    email: text("email"),
    displayName: text("display_name"),
    status: accessStatusEnum("status").notNull().default("pending"),
    /** Set when approved; the role copied onto `app_user`. */
    role: userRoleEnum("role"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    /** Null when the admin had no `app_user` row (env bootstrap operator). */
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Kept alongside the id so the trail survives a deleted admin account. */
    decidedByEmail: text("decided_by_email"),
    ...timestamps,
  },
  (table) => [
    // THE identity key. Doubles as the tenant_id index (leftmost prefix), and
    // makes the same id string under two providers two distinct people.
    unique("access_request_tenant_identity_uq").on(
      table.tenantId,
      table.provider,
      table.providerAccountId,
    ),
    // The session lookup runs on EVERY request, and must resolve to at most one
    // identity — hence unique, not just indexed.
    unique("access_request_tenant_session_email_uq").on(table.tenantId, table.sessionEmail),
    // The admin screen reads "pending of this tenant, newest first".
    index("access_request_tenant_status_idx").on(table.tenantId, table.status, table.requestedAt),
  ],
);

export type AccessRequestRow = typeof accessRequests.$inferSelect;
export type NewAccessRequestRow = typeof accessRequests.$inferInsert;
