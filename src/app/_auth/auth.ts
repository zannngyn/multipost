import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";

import { loadMetaOAuthConfig } from "@/composition/config";
import { FACEBOOK_CONNECT_SCOPES, getContainer } from "@/composition/container";
import { AppError } from "@/core/domain/errors";
import { facebookSessionEmail } from "@/shared/operator-access";
import { SignInWithPasswordSchema } from "@/shared/password-policy";

import { buildBaseAuthConfig, loadAuthEnv } from "./auth.config";
import { PASSWORD_PROVIDER_ID, PasswordSignInError } from "./password-errors";
import { importChannelsFromSignIn } from "./signin-channel-import";
import { decideSignIn } from "./signin-gate";

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
 * E-mail + password. Always on — there is no `AUTH_PASSWORD_ENABLED`: a door
 * that some deployments have and others do not is a door the sign-in screen has
 * to ask about, and the account tables gate it exactly like the OAuth ones.
 *
 * `id: "password"` (not the default `"credentials"`) so ONE word means this
 * everywhere: the `access_provider` enum value, `identity.provider`, the
 * sign-in gate's verdict branch and `signIn("password", ...)` in the server
 * action. Two names for one concept is how the wrong branch gets taken.
 *
 * WHY THE VERIFICATION LIVES HERE, and not in the server action that calls
 * `signIn`: `/api/auth/callback/password` is a real endpoint that a client can
 * POST to directly (with a CSRF token). If the action verified and this only
 * minted a cookie, that endpoint would be an unauthenticated session vending
 * machine. `authorize` is the ONE choke point every path goes through, so the
 * password is checked exactly once, here.
 */
function passwordProvider(): ReturnType<typeof Credentials> {
  return Credentials({
    id: PASSWORD_PROVIDER_ID,
    name: "Email và mật khẩu",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Mật khẩu", type: "password" },
    },
    async authorize(raw) {
      // --- Edge cases first: the payload is a form body, i.e. untrusted -----
      const parsed = SignInWithPasswordSchema.safeParse({
        email: raw?.email,
        password: raw?.password,
      });
      if (!parsed.success) {
        // Same refusal a wrong password gets — a shape complaint here would
        // tell a probe which addresses are even worth trying.
        throw new PasswordSignInError("AUTH_INVALID_CREDENTIALS");
      }

      const container = getContainer();
      try {
        const identity = await container.usecases.passwordAuth.signIn(parsed.data);
        /**
         * `id` becomes `account.providerAccountId` (see the signIn callback
         * above), and for a password identity the KEY IS THE ADDRESS — so the
         * gate looks the person up under exactly the string the `identity` row
         * holds.
         */
        return {
          id: identity.sessionEmail,
          email: identity.sessionEmail,
          name: identity.displayName,
        };
      } catch (error) {
        /**
         * NOT swallowed: the usecase already logged the real reason with its
         * code, and the AppError is re-thrown here as the ONE error type
         * @auth/core forwards intact to the server action (`CredentialsSignin`
         * subclasses survive `Auth()`; anything else is rebranded
         * `CallbackRouteError` and the reason is lost).
         */
        const appError = AppError.from(error, "INTERNAL");
        container.logger.warn("Password authorize refused the sign-in", {
          error_code: appError.code,
          provider: PASSWORD_PROVIDER_ID,
        });
        throw new PasswordSignInError(appError.code, appError.userMessage);
      }
    },
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = loadAuthEnv();
  const base = buildBaseAuthConfig();
  const facebook = facebookProvider();

  const config: NextAuthConfig = {
    ...base,
    callbacks: {
      ...base.callbacks,
      /**
       * Overrides the fail-closed env-only gate of auth.config: this one also
       * consults the access registry (see ./signin-gate). The container is
       * resolved per call, not at module load, so `next build` needs no DB.
       */
      signIn: ({ account, profile, user }) => {
        const container = getContainer();
        /**
         * A CREDENTIALS callback carries NO `profile` — @auth/core builds
         * `account` from the object `authorize` returned and passes that object
         * as `user` (lib/actions/callback: `{providerAccountId: user.id, type:
         * "credentials", provider: provider.id}`). Reading `profile` here would
         * hand the gate an identity with no address, which it correctly refuses.
         *
         * `emailVerified` stays undefined for passwords and that is right:
         * `evaluateEnvAllowList` never reads it on this branch (there is no
         * third party whose verification we could be trusting). What proves the
         * address here is having signed up with it — the same standing a
         * password account has anywhere.
         */
        const isPassword = account?.provider === PASSWORD_PROVIDER_ID;
        return decideSignIn(
          {
            signInAccount: (input) => container.usecases.operatorAccounts.signIn(input),
            // M2.4: a first sign-in provisions the person; the approval queue
            // (`operatorAccess.register`) is retired and no longer written.
            provisionAccount: (input) => container.usecases.operatorAccounts.provision(input),
            logger: container.logger,
          },
          {
            provider: account?.provider,
            providerAccountId: account?.providerAccountId,
            email: isPassword ? user?.email : profile?.email,
            emailVerified: profile?.email_verified,
            displayName: isPassword ? user?.name : profile?.name,
          },
        );
      },
    },
    providers: [
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Operators often hold several Google accounts; always let them pick.
        authorization: { params: { prompt: "select_account" } },
      }),
      ...(facebook ? [facebook] : []),
      passwordProvider(),
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
        const facebookUserId =
          typeof account.providerAccountId === "string" ? account.providerAccountId : null;
        const sessionEmail = facebookSessionEmail(facebookUserId);
        if (!sessionEmail) return; // unusable id — decideSignIn already refused it
        const container = getContainer();
        // Target tenant comes from the person's OWN membership (M1.4) — the
        // demo-tenant pin is gone; see signin-channel-import for the rules.
        await importChannelsFromSignIn(
          {
            resolveAccount: (email) => container.usecases.operatorAccounts.resolve(email),
            requireTenant: (session, selector, options) =>
              container.usecases.requireTenant(session, selector, options),
            importChannels: (input) => container.usecases.connectChannels.importChannels(input),
            logger: container.logger,
          },
          { userAccessToken: token, sessionEmail, facebookUserId },
        );
      },
    },
  };

  return config;
});
