import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { accounts } from "./account";

/**
 * A PASSWORD for signing in (docs/09 §3.1 — a third way in, next to Google and
 * Facebook). One row per account that has one; an OAuth-only person has none.
 *
 * WHY IT IS NOT A COLUMN ON `identity`:
 * - `identity` is the identity KEY table and is read on every request by the
 *   session lookup. A password hash and a failure counter are write-hot secrets
 *   that have no business travelling on that read;
 * - the hash is the one column in this database that must never be selected by
 *   a generic "give me the person" query. A separate table makes that mistake
 *   impossible to make by accident.
 *
 * The matching `identity` row still exists and carries `provider='password'`,
 * `provider_account_id = <normalised e-mail>` — so a password person resolves
 * through exactly the same session path (identity -> account -> membership) as
 * a Google person, and no downstream code learns a second shape.
 */
export const credentials = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /**
     * THE identity key of this table, lower-cased and trimmed by the writer:
     * Postgres text is case-sensitive and the unique index below only holds if
     * callers normalise. Unique GLOBALLY — a lookup that can return two rows is
     * a lookup that authorises the wrong person.
     */
    email: text("email").notNull(),
    /**
     * `scrypt$N$r$p$<salt>$<key>` (adapters/auth/scrypt-password-hasher). The
     * parameters travel WITH the digest so raising the cost later does not
     * invalidate stored rows. Never logged, never returned to a client.
     */
    passwordHash: text("password_hash").notNull(),
    /** Consecutive failures. Reset to 0 the moment a sign-in succeeds. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    /**
     * Set when the counter trips MAX_FAILED_ATTEMPTS; null otherwise. In the
     * DATABASE rather than in the rate limiter on purpose: this one survives a
     * restart, a second web process and an attacker who rotates IP addresses.
     */
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    unique("credential_email_uq").on(table.email),
    // "Does this person have a password" — the admin reset and the account
    // screen both read that way.
    index("credential_account_idx").on(table.accountId),
  ],
);

export type CredentialRow = typeof credentials.$inferSelect;
export type NewCredentialRow = typeof credentials.$inferInsert;
