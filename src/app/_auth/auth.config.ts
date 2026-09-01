import type { NextAuthConfig } from "next-auth";

import { loadAuthConfig, type AuthConfig } from "@/composition/config";
import { facebookIdFromSessionEmail, facebookSessionEmail } from "@/shared/operator-access";

/**
 * Edge-safe half of the Auth.js v5 setup (official split pattern).
 *
 * This module must stay importable from `middleware.ts`: no pino, no postgres,
 * no container — only zod-validated env and pure functions. The Google provider
 * (and anything else needing Node APIs) lives in `./auth.ts`.
 *
 * SESSION REVOCATION (CLAUDE.md "Bẫy đã gặp"):
 * `strategy: "jwt"` means the session lives entirely in a stateless cookie, so
 * a decision taken HERE (in `signIn`) is frozen for the life of the token —
 * blocking someone in the database would not end their session. That is why the
 * access status is re-read per request in `session.ts` instead, which runs in
 * Node and can reach the database; this file must stay edge-safe and therefore
 * cannot. A general "sign out everywhere" (a `sessions_valid_after` cut-off)
 * is still not built; the short max-age below bounds a stolen token.
 */

/** Public sign-in page. Also the error page, so failures land where the button is. */
export const SIGNIN_PATH = "/signin";

/**
 * `?error=` value telling the sign-in screen "you are in the queue", as opposed
 * to Auth.js's generic `AccessDenied` ("bạn không có quyền"). Its own code
 * because the two need different sentences: one says wait, the other says stop.
 *
 * snake_case deliberately: every code Auth.js itself emits is PascalCase, so
 * this can never collide with one (`src/app/signin/page.tsx` matches on it).
 */
export const SIGNIN_ERROR_PENDING_APPROVAL = "pending_approval";

/** Where a held-back sign-in lands. Relative on purpose — Auth.js prefixes the origin. */
export const PENDING_APPROVAL_REDIRECT = `${SIGNIN_PATH}?error=${SIGNIN_ERROR_PENDING_APPROVAL}`;

/** 8h: one working day. Bounds the blast radius of a stolen token (see debt note). */
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Parsed once per process. Config is env-driven and immutable at runtime, and
 * re-parsing on every request would burn CPU on every middleware invocation.
 * Kept lazy so `next build` does not require real Google credentials.
 */
let cachedAuthEnv: AuthConfig | null = null;

export function loadAuthEnv(): AuthConfig {
  if (!cachedAuthEnv) {
    cachedAuthEnv = loadAuthConfig();
    // Once per process, right where the auth env first becomes known.
    warnWhenNoBootstrapAdmin(cachedAuthEnv);
  }
  return cachedAuthEnv;
}

/**
 * No bootstrap admin no longer BRICKS a deployment (M2.4: strangers provision
 * their own account and found their own company), but it still deserves a
 * warning: the env lists are the platform ESCAPE HATCH — the only door that
 * opens when the database is broken, and (until M3.1's platform roles) the
 * only identity guaranteed to reach /access history and repair screens.
 *
 * A warning, not a throw: the app must stay up for operators whose sessions
 * work. `console` rather than pino — this module is imported by the edge
 * middleware (see the file header).
 */
export function warnWhenNoBootstrapAdmin(env: AuthConfig): void {
  if (env.AUTH_BOOTSTRAP_ADMINS?.length) return;
  if (env.AUTH_FACEBOOK_ALLOWED_USER_IDS?.length) return;

  warnAuth(
    "No bootstrap admin is configured: there is NO emergency door if the database breaks (self-service sign-up still works). Set AUTH_BOOTSTRAP_ADMINS (exact e-mail addresses) or AUTH_FACEBOOK_ALLOWED_USER_IDS (exact Facebook user ids).",
    {
      error_code: "UNAUTHORIZED",
      reason: "NO_BOOTSTRAP_ADMIN",
      alert: "OPERATOR_ATTENTION",
      user_message:
        "Chưa cấu hình quản trị viên khẩn cấp (bootstrap) — khi hệ thống lỗi sẽ không có lối vào dự phòng.",
    },
  );
}

/**
 * Does this address sit in one of the listed domains? Pure so it can be
 * unit-tested without Auth.js. Rejects anything that is not exactly
 * `local@domain` — no multi-@ addresses, no empty domain, no case tricks
 * (`@Example.COM` matches `example.com`).
 *
 * MEMBERSHIP ONLY — it grants nothing. A domain names an open-ended set of
 * people, so it may narrow who can sign in (`passesDomainFilter`) but never who
 * is an admin. Individual grants: `isBootstrapAdminEmail` / `isAllowedFacebookUser`.
 */
export function isAllowedEmail(email: unknown, allowedDomains: readonly string[]): boolean {
  if (typeof email !== "string") return false;
  if (allowedDomains.length === 0) return false;

  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return false;

  const [localPart, domain] = parts;
  if (!localPart || !domain) return false;

  return allowedDomains.includes(domain);
}

/**
 * Facebook allow-list check. The identity key is the provider user id, never the
 * e-mail: Facebook does not always return one, and an e-mail can move between
 * accounts (core-auth-methods — "e-mail from a provider is not an identity").
 * An empty or absent list rejects everyone, so forgetting to configure it fails
 * closed instead of opening the tool to anyone with a Facebook account.
 */
export function isAllowedFacebookUser(
  providerAccountId: unknown,
  allowedIds: readonly string[] | undefined,
): boolean {
  if (typeof providerAccountId !== "string") return false;
  const id = providerAccountId.trim().toLowerCase();
  if (id.length === 0) return false;
  if (!allowedIds || allowedIds.length === 0) return false;
  return allowedIds.includes(id);
}

/**
 * The Google DOMAIN FILTER: a necessary condition for signing in, never a grant.
 *
 * An EMPTY/absent list means NO FILTER — every verified Google address may
 * *attempt* to sign in, and the `access_request` registry decides the rest
 * (a new identity starts `pending`, so this is not an open door). That is a
 * deliberate change of meaning: the list used to reject everyone when empty,
 * which locked approved operators out of both deploy env examples, where it
 * ships blank.
 */
export function passesDomainFilter(email: unknown, allowedDomains: readonly string[] | undefined): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  return isAllowedEmail(email, allowedDomains);
}

/**
 * Is this EXACT address a bootstrap admin? The escape hatch, and the only
 * e-mail-shaped thing in this file that grants anything — hence exact matching
 * against a list of individuals, never a domain.
 */
export function isBootstrapAdminEmail(
  email: unknown,
  bootstrapAdmins: readonly string[] | undefined,
): boolean {
  if (typeof email !== "string") return false;
  const address = email.trim().toLowerCase();
  if (address.length === 0) return false;
  if (!bootstrapAdmins || bootstrapAdmins.length === 0) return false;
  return bootstrapAdmins.includes(address);
}

/** Structured warn without pulling the pino adapter into the edge/auth bundle. */
function warnAuth(message: string, context: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", time: new Date().toISOString(), message, ...context }));
}

/**
 * What the ENV allow-lists alone can decide about a sign-in. Pure, so it works
 * in the edge bundle and in a unit test.
 *
 * ORDER OF PRECEDENCE for access (M3.1 — same wording in session.ts and
 * signin-gate.ts; change one, change all three):
 *   1. `DEV_FAKE_SESSION` (local dev only, see dev-session.ts);
 *   2. the ACCOUNT TABLES, the moment a row exists — including for bootstrap
 *      admins, whose env entry is only a SEED (promoted once to
 *      platform_role='super_admin', audited) and a RESCUE (no row yet, or the
 *      DB is unreachable). A suspended row refuses even them (N9);
 *   3. the env BOOTSTRAP lists — AUTH_BOOTSTRAP_ADMINS (exact addresses) and
 *      AUTH_FACEBOOK_ALLOWED_USER_IDS (exact ids) — seed + rescue only. Both
 *      name INDIVIDUALS: that is the shape a grant must have.
 *
 * AUTH_ALLOWED_DOMAINS is deliberately absent from that list: it only filters
 * WHO MAY TRY (see passesDomainFilter). Matching the domain gets an operator as
 * far as `pending`, no further.
 *
 * A "reject" here is final: nothing in the registry can rescue an unverified
 * e-mail, a provider we do not support, or an address outside the domain filter.
 */
export type EnvAllowListVerdict = "allow" | "reject" | "consult_registry";

export interface SignInIdentityInput {
  readonly provider: unknown;
  readonly providerAccountId: unknown;
  readonly email: unknown;
  readonly emailVerified: unknown;
}

export function evaluateEnvAllowList(input: SignInIdentityInput): EnvAllowListVerdict {
  const env = loadAuthEnv();

  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  /**
   * PASSWORD goes straight to the registry, skipping the domain filter.
   *
   * AUTH_ALLOWED_DOMAINS exists to narrow which GOOGLE WORKSPACE may knock —
   * it is a statement about a third party's user directory. A password account
   * has no directory behind it; the credential row IS the membership decision,
   * and it only exists because someone signed up on this deployment. Applying
   * the Google filter here would silently lock every password account out the
   * day an admin narrows the list for an unrelated reason.
   *
   * `consult_registry`, never `allow`: the account tables still decide, so a
   * suspended password account is refused exactly like a suspended Google one.
   * There is no env bootstrap door for passwords by design — the escape hatch
   * must not be something an attacker can create by filling in a form.
   */
  if (input?.provider === "password") return "consult_registry";

  if (input?.provider !== "google" && input?.provider !== "facebook") {
    warnAuth("Sign-in rejected: unexpected provider", {
      error_code: "UNAUTHORIZED",
      provider: typeof input?.provider === "string" ? input.provider : null,
    });
    return "reject";
  }

  /**
   * Facebook is gated by provider user id, never by e-mail: an address can move
   * between accounts, and matching a Google operator by it would hand this tool
   * to whoever registered that address at Facebook (account-linking hijack).
   */
  if (input.provider === "facebook") {
    return isAllowedFacebookUser(input.providerAccountId, env.AUTH_FACEBOOK_ALLOWED_USER_IDS)
      ? "allow"
      : "consult_registry";
  }

  if (input?.emailVerified !== true) {
    warnAuth("Sign-in rejected: Google e-mail not verified", {
      error_code: "UNAUTHORIZED",
      provider: "google",
    });
    return "reject";
  }

  // The escape hatch, checked before the filter so a bootstrap admin stays
  // reachable even if the domain list is later narrowed by mistake.
  if (isBootstrapAdminEmail(input?.email, env.AUTH_BOOTSTRAP_ADMINS)) return "allow";

  if (!passesDomainFilter(input?.email, env.AUTH_ALLOWED_DOMAINS)) {
    warnAuth("Sign-in rejected: e-mail domain is outside AUTH_ALLOWED_DOMAINS", {
      error_code: "UNAUTHORIZED",
      provider: "google",
      allowed_domains: env.AUTH_ALLOWED_DOMAINS ?? [],
    });
    return "reject";
  }

  // Passing the filter buys an entry in the queue, not access.
  return "consult_registry";
}

/**
 * Is the identity behind this SESSION address a bootstrap admin — i.e. allowed
 * in without the registry, able to approve others, and impossible to block?
 *
 * Both lists it reads name individuals (exact address / exact Facebook id).
 * AUTH_ALLOWED_DOMAINS is NOT consulted: a domain grants nothing, and reading it
 * here is exactly what once made every colleague an unblockable admin.
 *
 * The Facebook id is recovered from the synthetic address the `jwt` callback
 * wrote (`fb-<id>@facebook.local`), which is precisely why that address is built
 * from the provider id and not from the profile e-mail.
 */
export function isBootstrapOperatorEmail(sessionEmail: unknown): boolean {
  const env = loadAuthEnv();
  const facebookId = facebookIdFromSessionEmail(sessionEmail);
  if (facebookId) return isAllowedFacebookUser(facebookId, env.AUTH_FACEBOOK_ALLOWED_USER_IDS);
  return isBootstrapAdminEmail(sessionEmail, env.AUTH_BOOTSTRAP_ADMINS);
}

export function buildBaseAuthConfig(): NextAuthConfig {
  const env = loadAuthEnv();

  return {
    secret: env.SESSION_SECRET,
    // The app runs behind Caddy on our own VPS, never on Vercel: Auth.js cannot
    // auto-detect the public host, so we trust the forwarded one (deploy/E1.2).
    trustHost: true,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: {
      signIn: SIGNIN_PATH,
      // Failures (incl. AccessDenied from the domain check) come back to the
      // sign-in page as ?error=..., translated to Vietnamese there.
      error: SIGNIN_PATH,
    },
    providers: [],
    callbacks: {
      /**
       * Auth.js derives `session.user` from the token's e-mail and returns NO
       * user at all when it is missing — the middleware then treats a perfectly
       * valid cookie as "not signed in" and bounces the operator back to
       * /signin. Facebook does not guarantee an address (accounts registered
       * with a phone number have none), so the address is synthesised from the
       * identity key that IS guaranteed: the provider user id.
       *
       * It is deliberately unroutable (.local) and unmistakably internal — a
       * name for the audit trail, never something to send mail to. Access is
       * decided by the allow-list and the registry, never by this address.
       */
      jwt({ token, account, profile }) {
        if (account?.provider !== "facebook") return token;

        /**
         * ALWAYS the synthetic address, even when the profile does carry an
         * e-mail: it is the registry's identity key, and reusing the provider
         * address would file a Facebook account under a Google operator's
         * identity (see shared/operator-access). A `null` here means an id we
         * refuse to embed — the session then has no e-mail and is treated as no
         * session, which is the safe reading.
         */
        const sessionEmail = facebookSessionEmail(account.providerAccountId);
        if (sessionEmail) token.email = sessionEmail;
        if (!token.name && typeof profile?.name === "string") {
          token.name = profile.name;
        }
        return token;
      },

      /**
       * FAIL-CLOSED DEFAULT: only the env bootstrap admins pass here.
       *
       * The real gate (which also consults the `access_request` registry and
       * can answer "đang chờ duyệt") lives in ./auth.ts, because it needs the
       * database and this module must stay importable from the edge middleware.
       * Middleware never runs an OAuth flow, so this callback is not reached in
       * that bundle — but if it ever were, refusing is the safe answer.
       */
      signIn({ account, profile }) {
        return (
          evaluateEnvAllowList({
            provider: account?.provider,
            providerAccountId: account?.providerAccountId,
            email: profile?.email,
            emailVerified: profile?.email_verified,
          }) === "allow"
        );
      },
    },
  };
}
