/**
 * The support-mode session cookie (M3.3). Carries ONLY the opaque row id of
 * `platform_access_session` — the row, read fresh on every use, is the
 * authorisation; the cookie is a pointer. Path `/` because tenant-scoped R
 * routes anywhere may serve a support read; Max-Age mirrors the row's 1h TTL
 * (the ROW is what actually expires — a stale cookie just reads as absent).
 */

export const SUPPORT_SESSION_COOKIE = "mysp_support_session";
export const SUPPORT_SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildSupportSessionCookie(sessionId: string, options: { secure: boolean }): string {
  return [
    `${SUPPORT_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    `Max-Age=${SUPPORT_SESSION_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSupportSessionCookie(options: { secure: boolean }): string {
  return [
    `${SUPPORT_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** The session id, or null. Malformed values read as absent — the fresh DB
 * check downstream is what authorises; this only refuses obvious garbage. */
export function readSupportSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SUPPORT_SESSION_COOKIE}=`));
  if (!raw) return null;

  let value: string;
  try {
    value = decodeURIComponent(raw.slice(SUPPORT_SESSION_COOKIE.length + 1)).trim();
  } catch {
    // Broken percent-encoding: edited or corrupted — read as absent.
    return null;
  }
  return UUID_SHAPE.test(value) ? value : null;
}
