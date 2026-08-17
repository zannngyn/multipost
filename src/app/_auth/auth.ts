import NextAuth, { type NextAuthConfig } from "next-auth";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";

import { loadMetaOAuthConfig } from "@/composition/config";
import { DEMO_TENANT_ID, FACEBOOK_CONNECT_SCOPES, getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

import { buildBaseAuthConfig, loadAuthEnv } from "./auth.config";

/**
 * Full Auth.js v5 instance: base config + the providers.
 * Imported by the route handler, Server Components and Server Actions — never
 * by `middleware.ts` (see ./auth.config.ts for the edge-safe half).
 *
 * The config is built lazily (per request) on purpose: `loadAuthConfig()` throws
 * when Google credentials are missing, and `next build` must not require them.
 */

/**
 * Sign-in with Facebook asks for the SAME scopes the channel import needs, so
 * one round trip both authenticates the operator and yields a User Access Token
 * we can turn into Page tokens.
 *
 * `email` is in the list even though the ACCESS gate is the user-id allow-list:
 * Auth.js builds `session.user` from the token's e-mail and drops the user
 * entirely when there is none, which made every Facebook sign-in land back on
 * /signin with a valid cookie. It needs no App Review (Meta grants
 * public_profile and email automatically). Accounts that still return no
 * address are handled by the fallback in auth.config's `jwt` callback.
 */
const FACEBOOK_SIGNIN_SCOPES = ["public_profile", "email", ...FACEBOOK_CONNECT_SCOPES].join(",");

/**
 * The Facebook provider is optional: it needs the Meta app credentials, and a
 * deployment without them must still serve Google sign-in rather than crash.
 * Returns null (and says so once) when they are absent.
 */
function facebookProvider(): ReturnType<typeof Facebook> | null {
  // The three Meta variables are optional by design (blankAsUndefined), so this
  // reads them and checks, rather than catching: a missing app id is a normal
  // state of an install that never uses Facebook sign-in, not an exception.
  const meta = loadMetaOAuthConfig();
  if (!meta.META_APP_ID || !meta.META_APP_SECRET) return null;

  return Facebook({
    clientId: meta.META_APP_ID,
    clientSecret: meta.META_APP_SECRET,
    authorization: { params: { scope: FACEBOOK_SIGNIN_SCOPES } },
  });
}

/**
 * E5.2 — the Page tokens are harvested from the very token that just signed the
 * operator in, so connecting channels needs no second trip to Facebook.
 *
 * Runs as an EVENT, not inside the `signIn` callback: a failure here must not
 * keep the operator out of the tool. Losing the channel import is bad; losing
 * the way in is worse. Every failure is logged with its error code instead.
 *
 * PENDING(tenant-mapping): there is no user -> tenant mapping yet (one tenant
 * today), so the import targets the seeded tenant. Multi-tenant sign-in needs a
 * product decision, not a guess here.
 */
async function importChannelsFromSignIn(
  userAccessToken: string,
  facebookUserId: string | null,
): Promise<void> {
  const container = getContainer();
  const log = container.logger.child({
    tenant_id: DEMO_TENANT_ID,
    provider: "facebook",
    step: "import_on_signin",
  });

  try {
    const result = await container.usecases.connectChannels.importChannels({
      tenantId: DEMO_TENANT_ID,
      userAccessToken,
      // No e-mail on purpose: Facebook may not return one, and matching an
      // operator by e-mail across providers is the account-linking hijack.
      actorEmail: null,
    });
    log.info("Imported Facebook Pages from the sign-in token", {
      imported: result.imported,
      updated: result.updated,
      // Loud on purpose: a Page listed without a token is a Page the operator
      // will look for and not find.
      skipped: result.skipped,
      facebook_user_id: facebookUserId,
    });
  } catch (error) {
    const appError = AppError.from(error, "INTERNAL");
    log.error("Could not import Pages from the sign-in token — sign-in still allowed", {
      error_code: appError.code,
      facebook_user_id: facebookUserId,
      alert: "OPERATOR_ATTENTION",
      err: appError,
    });
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = loadAuthEnv();
  const base = buildBaseAuthConfig();
  const facebook = facebookProvider();

  const config: NextAuthConfig = {
    ...base,
    providers: [
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Operators often hold several Google accounts; always let them pick.
        authorization: { params: { prompt: "select_account" } },
      }),
      ...(facebook ? [facebook] : []),
    ],
    events: {
      ...base.events,
      async signIn({ account }) {
        if (account?.provider !== "facebook") return;
        const token = typeof account.access_token === "string" ? account.access_token : "";
        if (token.length === 0) {
          getContainer().logger.warn("Facebook sign-in carried no access token", {
            error_code: "TOKEN_EXPIRED",
            provider: "facebook",
            step: "import_on_signin",
          });
          return;
        }
        await importChannelsFromSignIn(
          token,
          typeof account.providerAccountId === "string" ? account.providerAccountId : null,
        );
      },
    },
  };

  return config;
});
