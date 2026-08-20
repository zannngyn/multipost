import { index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { accounts } from "./account";
// The `access_provider` Postgres type outlives the `access_request` table it was
// born in (that table retires at M2.4, docs/09 §4). When the table goes, move the
// pgEnum declaration into this file and keep the SQL type name — a re-export is a
// code move, a rename would be a migration.
import { accessProviderEnum } from "./access-request";

/**
 * A WAY TO SIGN IN (docs/09 §3.1). `(provider, provider_account_id)` is the
 * stable identity; the e-mail is only an attribute of it. Google and Facebook
 * logins of the same human stay two accounts until someone links them
 * explicitly — linking then means moving `account_id`, not merging rows.
 * Auto-linking by matching e-mail is exactly the hijack the sign-in gate exists
 * to prevent, so nothing in this schema makes it easy.
 */
export const identities = pgTable(
  "identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: accessProviderEnum("provider").notNull(),
    /** App-scoped for Facebook, `sub` for Google. Stable per provider + app. */
    providerAccountId: text("provider_account_id").notNull(),
    /**
     * The address this identity's JWT session carries — synthetic for Facebook
     * (`fb-<id>@facebook.local`, see shared/operator-access). Lower-cased by the
     * writer: Postgres text is case-sensitive and the unique index below only
     * holds if callers normalise.
     *
     * UNIQUE GLOBALLY, unlike `access_request.session_email` which is unique per
     * tenant: from M1.2 this is THE lookup that turns a JWT into a person, and a
     * lookup that can return two rows is a lookup that authorises the wrong one.
     */
    sessionEmail: text("session_email").notNull(),
    /** What the provider actually returned. Null is normal for Facebook. */
    email: text("email"),
    ...timestamps,
  },
  (table) => [
    unique("identity_session_email_uq").on(table.sessionEmail),
    unique("identity_provider_account_uq").on(table.provider, table.providerAccountId),
    // "Which logins does this person have" — the account screen and the future
    // linking flow both read this way.
    index("identity_account_idx").on(table.accountId),
  ],
);

export type IdentityRow = typeof identities.$inferSelect;
export type NewIdentityRow = typeof identities.$inferInsert;
