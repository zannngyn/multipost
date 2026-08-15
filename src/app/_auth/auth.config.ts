import type { NextAuthConfig } from "next-auth";

import { loadAuthConfig, type AuthConfig } from "@/composition/config";

/**
 * Edge-safe half of the Auth.js v5 setup (official split pattern).
 *
 * This module must stay importable from `middleware.ts`: no pino, no postgres,
 * no container — only zod-validated env and pure functions. The Google provider
 * (and anything else needing Node APIs) lives in `./auth.ts`.
 *
 * TECH DEBT (CLAUDE.md "Bẫy đã gặp" — session revocation):
 * `strategy: "jwt"` means the session lives entirely in a stateless cookie.
 * Deleting rows or flipping a flag in the DB does NOT end an active session —
 * the token stays valid until `SESSION_MAX_AGE_SECONDS` elapses. A real
 * "sign out everywhere" needs a per-user `sessions_valid_after` cut-off stored
 * server-side and checked in the `jwt` callback. NOT implemented in E1: the
 * mitigation for now is the short max-age below.
 */

/** Public sign-in page. Also the error page, so failures land where the button is. */
export const SIGNIN_PATH = "/signin";

/** 8h: one working day. Bounds the blast radius of a stolen token (see debt note). */
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Parsed once per process. Config is env-driven and immutable at runtime, and
 * re-parsing on every request would burn CPU on every middleware invocation.
 * Kept lazy so `next build` does not require real Google credentials.
 */
let cachedAuthEnv: AuthConfig | null = null;

export function loadAuthEnv(): AuthConfig {
  cachedAuthEnv ??= loadAuthConfig();
  return cachedAuthEnv;
}

/**
 * Domain allow-list check. Pure so it can be unit-tested without Auth.js.
 * Rejects anything that is not exactly `local@domain` — no multi-@ addresses,
 * no empty domain, no case tricks (`@Example.COM` matches `example.com`).
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

/** Structured warn without pulling the pino adapter into the edge/auth bundle. */
function warnAuth(message: string, context: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", time: new Date().toISOString(), message, ...context }));
}

/**
 * Config shared by middleware (session decoding only) and the full auth handler.
 * `providers` is empty here on purpose — middleware never runs an OAuth flow.
 */
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
       * The only authorisation gate in E1: verified Google e-mail + allow-listed
       * domain. Returning `false` makes Auth.js redirect to `pages.error`.
       */
      signIn({ account, profile }) {
        const env = loadAuthEnv();
        const allowedDomains = env.AUTH_ALLOWED_DOMAINS;
        const email = typeof profile?.email === "string" ? profile.email : null;

        // --- Edge cases first (CLAUDE.md technical rule 1) -------------------
        if (account?.provider !== "google" && account?.provider !== "facebook") {
          warnAuth("Sign-in rejected: unexpected provider", {
            error_code: "UNAUTHORIZED",
            provider: account?.provider ?? null,
          });
          return false;
        }

        /**
         * Facebook has its own gate: an allow-list of user ids. It deliberately
         * does NOT fall through to the e-mail checks below — matching a Google
         * account by e-mail would hand this tool to whoever registered that
         * address at Facebook (core-auth-methods, account-linking hijack).
         */
        if (account.provider === "facebook") {
          if (!isAllowedFacebookUser(account.providerAccountId, env.AUTH_FACEBOOK_ALLOWED_USER_IDS)) {
            warnAuth("Sign-in rejected: Facebook user id not allow-listed", {
              error_code: "UNAUTHORIZED",
              provider: "facebook",
              facebook_user_id: account.providerAccountId ?? null,
              allow_list_configured: Boolean(env.AUTH_FACEBOOK_ALLOWED_USER_IDS?.length),
            });
            return false;
          }
          return true;
        }

        if (profile?.email_verified !== true) {
          warnAuth("Sign-in rejected: Google e-mail not verified", {
            error_code: "UNAUTHORIZED",
            email,
          });
          return false;
        }

        if (!isAllowedEmail(email, allowedDomains)) {
          warnAuth("Sign-in rejected: e-mail domain not allow-listed", {
            error_code: "UNAUTHORIZED",
            email,
            allowed_domains: allowedDomains,
          });
          return false;
        }

        return true;
      },
    },
  };
}
