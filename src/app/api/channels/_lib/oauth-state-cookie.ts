/**
 * The CSRF nonce of the Facebook connect round trip (E5.1), and the tenant it
 * belongs to, carried in ONE httpOnly cookie between /connect and /callback.
 *
 * Why a cookie and not the query string: the callback must prove that the
 * browser now coming back from facebook.com is the one that started the flow.
 * `state` alone in the URL proves nothing — the cookie is the half an attacker
 * cannot forge.
 *
 * Why the tenant id lives in here too: the callback then never has to trust a
 * tenant id from the query string, which anybody could edit.
 *
 * SameSite=Lax on purpose: the request arrives as a TOP-LEVEL redirect from
 * facebook.com, so Strict would drop the cookie and every connect would fail
 * with "state mismatch".
 */

export const OAUTH_STATE_COOKIE = "mysp_fb_oauth";
/** Long enough for a login + Page picker, short enough not to linger. */
export const OAUTH_STATE_TTL_SECONDS = 600;
/** Both endpoints of the flow live under this path; nothing else sees it. */
const COOKIE_PATH = "/api/channels";

export interface OAuthStatePayload {
  readonly state: string;
  readonly tenantId: string;
}

export function buildStateCookie(payload: OAuthStatePayload, options: { secure: boolean }): string {
  const value = encodeURIComponent(JSON.stringify(payload));
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Cleared on EVERY exit of the callback — success, cancel or error. */
export function clearStateCookie(options: { secure: boolean }): string {
  return [
    `${OAUTH_STATE_COOKIE}=`,
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
export type StateCookieResult =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly payload: OAuthStatePayload };

export function readStateCookie(request: Request): StateCookieResult {
  const header = request.headers.get("cookie");
  if (!header) return { kind: "absent" };

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`));
  if (!raw) return { kind: "absent" };

  const value = raw.slice(OAUTH_STATE_COOKIE.length + 1);
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
