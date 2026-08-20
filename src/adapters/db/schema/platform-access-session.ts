import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./_tenant-column";
import { accounts } from "./account";

/**
 * Support-mode session (M3.3, docs/09 §3.5): one row = one audited visit of a
 * platform staffer into ONE customer tenant, capped at an hour.
 *
 * The cookie carries only this row's OPAQUE id. A plain uuid is enough — no
 * hash, deliberately: the id is checked against this table FRESH on every use
 * (tier S), lives ≤1h, and is revocable server-side; the offline-guessing
 * threat that forces invite tokens to be hashed does not exist for a bearer
 * that only works while its row says so. (A uuid v4 also carries ~122 random
 * bits — the same entropy class as the invite tokens anyway.)
 *
 * There is deliberately NO way to extend `expires_at`: more time = a NEW
 * session = a NEW `platform.entered_tenant` audit row. Nesting is forbidden by
 * the writer (creating a session revokes the account's live ones first).
 */
export const platformAccessSessions = pgTable(
  "platform_access_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tenantId: tenantIdColumn(),
    /** Why the staffer is in there — mandatory, lands in the audit book too. */
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set = exited/revoked. Kept, not deleted: the visit happened. */
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "The live session of THIS account" — the write path's lookup, and the
    // one-at-a-time rule's enforcement scan.
    index("platform_access_session_account_idx").on(table.accountId),
  ],
);

export type PlatformAccessSessionRow = typeof platformAccessSessions.$inferSelect;
export type NewPlatformAccessSessionRow = typeof platformAccessSessions.$inferInsert;
