/**
 * The Google Drive connect nonce cookie (E2 / M1.3b).
 *
 * Since M1.3b the cookie carries ONLY an opaque nonce: the tenant, the account
 * and the expiry live in the server-side `oauth_state` row the nonce points at
 * (doc 10 §6). The old cookie carried `tenantId` in unsigned JSON and the
 * callback trusted it — the worst B-8 hole; nothing the browser holds decides
 * a tenant anymore.
 *
 * Deliberately a DIFFERENT cookie from the Facebook one (`mysp_fb_oauth`, path
 * /api/channels): the two flows can be started in two tabs, and sharing a name
 * would make the second start silently invalidate the first.
 *
 * Why a cookie at all: the callback must prove that the browser now coming
 * back from accounts.google.com is the one that started the flow. `state` in
 * the URL alone proves nothing — the cookie is the half an attacker cannot
 * forge.
 *
 * SameSite=Lax on purpose: the request arrives as a TOP-LEVEL redirect from
 * google.com, so Strict would drop the cookie and every connect would fail
 * with "state mismatch".
 */

export const GOOGLE_OAUTH_STATE_COOKIE = "mysp_google_oauth";
/** Matches OAUTH_STATE_TTL_MS server-side; the ROW is what actually expires. */
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 600;
/** Both endpoints of the flow live under this path; nothing else sees it. */
const COOKIE_PATH = "/api/catalog/google";

/** The nonce is 64 hex chars (32 random bytes); anything else is garbage. */
const NONCE_SHAPE = /^[0-9a-f]{32,128}$/i;

export function buildGoogleStateCookie(nonce: string, options: { secure: boolean }): string {
  return [
    `${GOOGLE_OAUTH_STATE_COOKIE}=${encodeURIComponent(nonce)}`,
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
 * The nonce, or null. A malformed value reads as ABSENT: the server-side claim
 * is what authorises, this only refuses to carry obvious garbage further — and
 * both outcomes end the flow the same way ("bấm kết nối lại").
 */
export function readGoogleStateCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`));
  if (!raw) return null;

  let value: string;
  try {
    value = decodeURIComponent(raw.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1)).trim();
  } catch {
    // Broken percent-encoding: edited or corrupted — read as absent.
    return null;
  }
  return NONCE_SHAPE.test(value) ? value : null;
}
