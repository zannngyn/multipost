import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { buildBaseAuthConfig, loadAuthEnv } from "./auth.config";

/**
 * Full Auth.js v5 instance: base config + the Google provider.
 * Imported by the route handler, Server Components and Server Actions — never
 * by `middleware.ts` (see ./auth.config.ts for the edge-safe half).
 *
 * The config is built lazily (per request) on purpose: `loadAuthConfig()` throws
 * when Google credentials are missing, and `next build` must not require them.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = loadAuthEnv();

  return {
    ...buildBaseAuthConfig(),
    providers: [
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Operators often hold several Google accounts; always let them pick.
        authorization: { params: { prompt: "select_account" } },
      }),
    ],
  };
});
