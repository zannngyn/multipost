/**
 * Fixture identifiers for the development seed. Side-effect free ON PURPOSE:
 * `seed.ts` runs a database script, so importing a constant from it used to
 * start a seed (racing inserts + a non-zero exit code) in any process that only
 * wanted the id. Import ids from here; import `seed()` from `./seed`.
 */

/** Fixed id so fixtures, tests and manual API calls can hard-code one tenant. */
export const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const DEMO_TENANT_NAME = "Demo Tenant";
export const DEMO_USER_EMAIL = "demo@mysp.local";
export const DEMO_USER_NAME = "Demo Operator";
