/**
 * The CSRF nonce of the Google Drive connect round trip (E2), and the tenant it
 * belongs to, carried in ONE httpOnly cookie between /connect and /callback.
 *
 * Deliberately a DIFFERENT cookie from the Facebook one (`mysp_fb_oauth`, path
 * /api/channels): the two flows can be started in two tabs, and sharing a name
 * would make the second start silently invalidate the first.
 *
 * Why a cookie and not the query string: the callback must prove that the
 * browser now coming back from accounts.google.com is the one that started the
 * flow. `state` alone in the URL proves nothing — the cookie is the half an
 * attacker cannot forge. The tenant id lives in here too, so the callback never
 * has to trust a tenant id from a query string anybody could edit.
 *
 * SameSite=Lax on purpose: the request arrives as a TOP-LEVEL redirect from
 * google.com, so Strict would drop the cookie and every connect would fail with
 * "state mismatch".
 */

export const GOOGLE_OAUTH_STATE_COOKIE = "mysp_google_oauth";
/** Long enough for a Google login + account chooser, short enough not to linger. */
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 600;
/** Both endpoints of the flow live under this path; nothing else sees it. */
const COOKIE_PATH = "/api/catalog/google";

export interface GoogleOAuthStatePayload {
  readonly state: string;
  readonly tenantId: string;
}

export function buildGoogleStateCookie(
  payload: GoogleOAuthStatePayload,
  options: { secure: boolean },
): string {
  const value = encodeURIComponent(JSON.stringify(payload));
  return [
    `${GOOGLE_OAUTH_STATE_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${GOOGLE_OAUTH_STATE_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Cleared on EVERY exit of the callback — success, cancel or error. */
export function clearGoogleStateCookie(options: { secure: boolean }): string {
  return [
    `${GOOGLE_OAUTH_STATE_COOKIE}=`,
    `Path=${COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Three outcomes, kept apart so the route can LOG the difference: no cookie at
 * all (expired, or third-party cookies blocked) is a different story from a
 * cookie that was edited. Both end the flow, neither is a 500.
 */
export type GoogleStateCookieResult =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly payload: GoogleOAuthStatePayload };

export function readGoogleStateCookie(request: Request): GoogleStateCookieResult {
  const header = request.headers.get("cookie");
  if (!header) return { kind: "absent" };

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`));
  if (!raw) return { kind: "absent" };

  const value = raw.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1);
  if (value.length === 0) return { kind: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    // The cause is worthless here (the value is attacker-controlled and may hold
    // a nonce); WHAT happened is reported to the caller as `malformed`, which is
    // logged there and shown to the operator as "phiên kết nối không hợp lệ".
    return { kind: "malformed" };
  }

  if (typeof parsed !== "object" || parsed === null) return { kind: "malformed" };
  const { state, tenantId } = parsed as { state?: unknown; tenantId?: unknown };
  if (typeof state !== "string" || state.trim().length === 0) return { kind: "malformed" };
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) return { kind: "malformed" };
  return { kind: "present", payload: { state: state.trim(), tenantId: tenantId.trim() } };
}
