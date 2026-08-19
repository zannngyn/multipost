import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { accounts } from "./account";
import { userRoleEnum } from "./user";

/**
 * Invite link — replaces the env whitelist (docs/09 §3.6). Created here at M1.1
 * so the schema settles in one migration; NOTHING reads or writes it until M2.2.
 *
 * The raw token never touches the database: it is a ≥128-bit random string shown
 * once to the inviter, and only its hash is stored. A dump of this table
 * therefore cannot be replayed into memberships.
 *
 * `role` is the role the invite GRANTS. The server checks it against the
 * inviter's own role when the invite is created (owner→owner, admin→editor and
 * below); the client never gets to name an accepted role.
 */
export const invites = pgTable(
  "invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    /** Hash of the link token. Unique globally: it IS the lookup key at /join. */
    tokenHash: text("token_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Single-use by default (docs/09 §3.6); a team link may raise it. */
    maxUses: integer("max_uses").notNull().default(1),
    usedCount: integer("used_count").notNull().default(0),
    createdByAccountId: uuid("created_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** Set = revoked. Kept rather than deleted so "who revoked what" stays readable. */
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    unique("invite_token_hash_uq").on(table.tokenHash),
    // The admin screen reads "invites of this company, newest first"; also the
    // tenant_id index (leftmost prefix).
    index("invite_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
