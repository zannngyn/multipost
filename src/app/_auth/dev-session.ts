import type { OperatorSession } from "./operator-session";

/**
 * DEV-ONLY authentication bypass.
 *
 * WHY IT EXISTS: E1 must be verifiable end-to-end (middleware -> RSC -> API ->
 * usecase -> Postgres) before real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
 * are issued. Without it the whole app is a redirect loop to a sign-in button
 * that cannot complete, and nothing downstream can be tested.
 *
 * HOW TO TURN IT OFF: remove `DEV_FAKE_SESSION` from `.env.local` (or set it to
 * anything other than "1"). It is off by default.
 *
 * TWO INDEPENDENT GUARDS, both must hold:
 *   1. `NODE_ENV === "development"` — Next inlines this as "production" in a
 *      production build, so the branch is statically dead there.
 *   2. `DEV_FAKE_SESSION === "1"` — explicit opt-in, exact string match.
 * Every bypassed request logs a warning: a silent auth bypass is worse than none.
 */

export const DEV_FAKE_SESSION_EMAIL = "dev@localhost";
const DEV_FAKE_SESSION_NAME = "Dev Bypass";

export function isDevFakeSessionEnabled(): boolean {
  // Guard 1: build-time constant in production bundles.
  if (process.env.NODE_ENV !== "development") return false;
  // Guard 2: runtime opt-in.
  return process.env.DEV_FAKE_SESSION === "1";
}

/**
 * Structured warning on every bypassed request. Uses `console` rather than the
 * pino adapter: the app layer must not import adapters, and this code also runs
 * inside `middleware.ts`.
 */
export function warnDevFakeSession(context: { surface: string; path?: string }): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      time: new Date().toISOString(),
      message: "DEV_FAKE_SESSION active — authentication bypassed for this request",
      error_code: "DEV_AUTH_BYPASS",
      email: DEV_FAKE_SESSION_EMAIL,
      ...context,
    }),
  );
}

/** Returns the fake operator when both guards hold, otherwise null. */
export function getDevFakeSession(surface: string): OperatorSession | null {
  if (!isDevFakeSessionEnabled()) return null;

  warnDevFakeSession({ surface });
  // `isBootstrapAdmin` so the bypass can reach the access-approval screen too:
  // a dev session that cannot test the admin flow is a dev session that hides
  // bugs in it. Both guards above still confine this to local development.
  return {
    email: DEV_FAKE_SESSION_EMAIL,
    name: DEV_FAKE_SESSION_NAME,
    isDevFake: true,
    role: null,
    isBootstrapAdmin: true,
  };
}
