/**
 * Where an OAuth round trip should land when it finishes.
 *
 * Both callbacks used to hardcode their screen (`/sync`, `/channels`). The
 * onboarding slideshow is a real route precisely BECAUSE the browser leaves
 * during these two steps — so it needs the callback to bring it home.
 *
 * A cookie rather than a query parameter or an `oauth_state` column: the state
 * row is security material and does not want a UI concern in it, and a query
 * parameter would be attacker-controllable. The cookie is set by our own
 * `connect` route, is HttpOnly, and carries a CLOSED value — never a URL.
 */

export const OAUTH_RETURN_COOKIE = "mysp_oauth_return";

/** The only accepted value. Anything else is treated as absent. */
export type OauthReturn = "onboarding";

/** Ten minutes: long enough for a slow consent screen, short enough to forget. */
const MAX_AGE_SECONDS = 600;

export function buildOauthReturnCookie(
  value: OauthReturn | null,
  { secure }: { secure: boolean },
): string {
  const parts = [
    `${OAUTH_RETURN_COOKIE}=${value ?? ""}`,
    "Path=/",
    "HttpOnly",
    // Lax, deliberately: the browser comes back from the provider through a
    // top-level GET navigation, which Lax allows and Strict does not.
    "SameSite=Lax",
    `Max-Age=${value ? MAX_AGE_SECONDS : 0}`,
  ];
  // Secure over plain http makes the cookie invisible, and every connect would
  // then look like it simply never set one.
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readOauthReturn(request: Request): OauthReturn | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name !== OAUTH_RETURN_COOKIE) continue;
    // A closed set, not a redirect target: an unexpected value is dropped
    // rather than followed.
    return rest.join("=") === "onboarding" ? "onboarding" : null;
  }
  return null;
}

export function resolveReturnScreen({
  request,
  defaultScreen,
  onboardingStep,
  query,
}: {
  request: Request;
  /** Where this callback has always sent people. Unchanged for everyone else. */
  defaultScreen: string;
  onboardingStep: "data" | "facebook";
  /** The outcome the callback already computed, e.g. `google=connected`. */
  query: string;
}): string {
  const target =
    readOauthReturn(request) === "onboarding"
      ? `/onboarding?step=${onboardingStep}&`
      : `${defaultScreen}?`;
  return `${target}${query}`;
}
