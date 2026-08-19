/**
 * Operator identity + access vocabulary, shared by every layer (docs/07 §2:
 * `shared/` is pure, imports no layer, does no I/O).
 *
 * It lives here rather than in `core/domain` because ALL FOUR layers need the
 * same words: the sign-in callback (app), the registry usecase (core), the
 * Drizzle repo (adapters) and the admin route's zod schema (app). The app layer
 * may only import `core/domain/errors`, so a second copy of these literals in a
 * route schema was the alternative — and a second copy is a second thing to
 * forget when a role is added.
 */

/** Sign-in providers this tool accepts. Anything else is rejected outright. */
export const OPERATOR_PROVIDERS = ["google", "facebook"] as const;
export type OperatorProvider = (typeof OPERATOR_PROVIDERS)[number];

/** Lifecycle of an access request. `pending` is what a first sign-in creates. */
export const ACCESS_STATUSES = ["pending", "approved", "blocked"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Mirrors the `user_role` pg enum in adapters/db/schema/user.ts. */
export const OPERATOR_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** Roles allowed to approve/block other operators. */
export const ACCESS_ADMIN_ROLES: readonly OperatorRole[] = ["owner", "admin"];

/**
 * Domain of the synthetic address a Facebook session carries.
 *
 * WHY IT EXISTS: Auth.js drops `session.user` entirely when the token has no
 * e-mail, and Facebook does not guarantee one (accounts registered with a phone
 * number have none). `.local` is unroutable on purpose — this is a name for the
 * audit trail, never something to send mail to.
 */
export const FACEBOOK_SESSION_EMAIL_DOMAIN = "facebook.local";

const FACEBOOK_SESSION_EMAIL_PREFIX = "fb-";

/**
 * Provider account ids we are willing to embed in an address. Facebook
 * app-scoped ids are digits; Google `sub` is digits too. Anything with an `@`,
 * a space or a control character would forge a different identity, so it is
 * refused rather than sanitised.
 */
const PROVIDER_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * local@domain, no spaces, exactly one `@`. Deliberately not RFC-complete, and
 * deliberately NOT requiring a dot in the domain: `dev@localhost` (the dev
 * bypass operator) is a real actor whose name belongs on the audit trail, and
 * `isAllowedEmail` in app/_auth accepts the same shape. Validating addresses
 * harder than the gate does only loses attribution.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export function isOperatorProvider(value: unknown): value is OperatorProvider {
  return typeof value === "string" && (OPERATOR_PROVIDERS as readonly string[]).includes(value);
}

export function isAccessStatus(value: unknown): value is AccessStatus {
  return typeof value === "string" && (ACCESS_STATUSES as readonly string[]).includes(value);
}

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === "string" && (OPERATOR_ROLES as readonly string[]).includes(value);
}

export function isAccessAdminRole(value: unknown): boolean {
  return isOperatorRole(value) && ACCESS_ADMIN_ROLES.includes(value);
}

/** Trimmed, lower-cased address — or null when there is nothing usable. */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 320) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** Trimmed provider account id, or null when it is missing/unsafe. */
export function normaliseProviderAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0) return null;
  return PROVIDER_ACCOUNT_ID_PATTERN.test(id) ? id : null;
}

/** Display name for the approval screen. Empty/garbage becomes null, not "". */
export function normaliseDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters would break a log line and a table cell alike.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  return name.length > 0 ? name : null;
}

/** `fb-<providerAccountId>@facebook.local`, or null for an unusable id. */
export function facebookSessionEmail(providerAccountId: unknown): string | null {
  const id = normaliseProviderAccountId(providerAccountId);
  if (!id) return null;
  return `${FACEBOOK_SESSION_EMAIL_PREFIX}${id.toLowerCase()}@${FACEBOOK_SESSION_EMAIL_DOMAIN}`;
}

/**
 * The address the JWT session carries for an identity — the ONE key everything
 * downstream (registry lookup, `app_user`, audit trail) is filed under.
 *
 * Facebook ALWAYS gets the synthetic address, even when the profile does carry
 * an e-mail. Two reasons, both load-bearing:
 *   1. a Facebook account whose e-mail happens to equal a Google operator's
 *      would otherwise resolve to the SAME session identity — the account
 *      linking hijack the sign-in gate exists to prevent;
 *   2. the address is then reversible back to the provider id, which is what
 *      lets the env bootstrap allow-list be checked from a session alone.
 */
export function operatorSessionEmail(input: {
  provider: unknown;
  providerAccountId: unknown;
  email?: unknown;
}): string | null {
  if (!isOperatorProvider(input?.provider)) return null;
  if (input.provider === "facebook") return facebookSessionEmail(input.providerAccountId);
  return normaliseEmail(input?.email);
}

/** The Facebook id inside a synthetic session address, or null for anything else. */
export function facebookIdFromSessionEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const suffix = `@${FACEBOOK_SESSION_EMAIL_DOMAIN}`;
  if (!email.startsWith(FACEBOOK_SESSION_EMAIL_PREFIX) || !email.endsWith(suffix)) return null;

  const id = email.slice(FACEBOOK_SESSION_EMAIL_PREFIX.length, email.length - suffix.length);
  return normaliseProviderAccountId(id);
}
