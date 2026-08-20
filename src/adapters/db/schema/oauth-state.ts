import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./_tenant-column";
import { accounts } from "./account";

/** Which third-party consent flow a state row belongs to (doc 10 §6). */
export const oauthPurposeEnum = pgEnum("oauth_purpose", ["google_drive", "facebook_pages"]);

/**
 * Server-side OAuth state (M1.3b, doc 10 §6). One row per started consent
 * round trip; the browser cookie carries ONLY an opaque nonce.
 *
 * Why a table and not the old signed-nothing cookie: the callback used to read
 * `tenantId` out of an UNSIGNED cookie and write credentials wherever it said —
 * the worst B-8 hole (docs/08). Here the tenant and the person are bound
 * SERVER-SIDE at the moment the flow starts; the callback takes both from this
 * row and re-checks the session's role fresh, so neither a forged cookie nor a
 * mid-consent tenant switch can redirect the credential.
 *
 * Why Postgres and not Redis: the single-use claim must be ATOMIC
 * (`UPDATE ... WHERE used_at IS NULL RETURNING`), which one SQL statement gives
 * for free; the volume is tiny (10-minute lifetime); and the existing
 * integration-test rig covers it. Redis would add a second store to a
 * security-critical path with weaker transactional guarantees and no test rig.
 *
 * `nonce_hash` (sha256), never the raw nonce: a database read (backup, log,
 * compromised replica) must not yield a value that completes someone's flow.
 */
export const oauthStates = pgTable(
  "oauth_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 hex of the cookie nonce. The raw nonce exists only in transit. */
    nonceHash: text("nonce_hash").notNull(),
    tenantId: tenantIdColumn(),
    /** Who started the flow; the callback must arrive as the same person. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    purpose: oauthPurposeEnum("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set atomically by the claim; a claimed row can never be claimed again. */
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("oauth_state_nonce_hash_uq").on(table.nonceHash),
    // For the periodic sweep of expired rows (10-minute lifetime, tiny table —
    // the sweep is a follow-up ticket; the index costs nothing now).
    index("oauth_state_expires_at_idx").on(table.expiresAt),
  ],
);

export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type NewOAuthStateRow = typeof oauthStates.$inferInsert;
