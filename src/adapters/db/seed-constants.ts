/**
 * Fixture identifiers for the development seed. Side-effect free ON PURPOSE:
 * `seed.ts` runs a database script, so importing a constant from it used to
 * start a seed (racing inserts + a non-zero exit code) in any process that only
 * wanted the id. Import ids from here; import `seed()` from `./seed`.
 */

/** Fixed id so fixtures, tests and manual API calls can hard-code one tenant. */
export const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const DEMO_TENANT_NAME = "Demo Tenant";
/** URL handle (docs/09 §3.7). Unique across tenants — the seed skips it if taken. */
export const DEMO_TENANT_SLUG = "demo";
export const DEMO_USER_EMAIL = "demo@mysp.local";
export const DEMO_USER_NAME = "Demo Operator";

/**
 * The operator the dev sign-in bypass pretends to be. The literal is duplicated
 * from `app/_auth/dev-session.ts` (`DEV_FAKE_SESSION_EMAIL`) rather than
 * imported: an adapter must not depend on the Next.js app layer (docs/07 §2).
 * Both sides are exercised by the seed + the dev bypass, so a drift shows up as
 * "dev login has no membership" on the first run after the change.
 *
 * Seeding it closes debt B-8's "seed dev@localhost" item (docs/08): from M1.2
 * the bypass resolves through `identity` → `account` → `membership` like every
 * other login, and an unseeded fake operator would simply be locked out.
 */
export const DEV_BYPASS_EMAIL = "dev@localhost";
export const DEV_BYPASS_NAME = "Dev Bypass";

/**
 * Placeholder provider account ids for the two seeded logins. They are NOT real
 * Google `sub` values — nobody ever signs in to Google as these — they only
 * satisfy `identity`'s UNIQUE (provider, provider_account_id). The seed keeps
 * whatever id an identity already carries for these addresses (the M1.1 backfill
 * mints `legacy-app-user:<email>`), so re-seeding an existing database never
 * rewrites a real one.
 */
export const DEMO_USER_PROVIDER_ACCOUNT_ID = "seed:demo-operator";
export const DEV_BYPASS_PROVIDER_ACCOUNT_ID = "seed:dev-bypass";
