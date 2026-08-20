/**
 * The active-tenant SELECTOR cookie (M1.2, docs/09 Q5). It only ever says which
 * company the operator would like to work in — `requireTenant()` re-checks the
 * membership in the database on every request, so a forged or stale value can
 * select nothing the person is not a member of.
 *
 * httpOnly even though it holds no secret: nothing client-side needs to read it
 * (the UI learns the active tenant from /api/me), and an unreadable cookie is
 * one less thing scripts can tamper with. SameSite=Lax, path `/` — every screen
 * and every API route lives under one origin. No `Secure` on a dev box (same
 * rule as the OAuth state cookies): over plain http the browser would drop it.
 */

export const ACTIVE_TENANT_COOKIE = "mysp_active_tenant";

/**
 * 30 days: a selector, not a credential — losing it costs one picker screen,
 * keeping it long spares the operator re-choosing every morning.
 */
export const ACTIVE_TENANT_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildActiveTenantCookie(tenantId: string, options: { secure: boolean }): string {
  return [
    `${ACTIVE_TENANT_COOKIE}=${encodeURIComponent(tenantId)}`,
    "Path=/",
    `Max-Age=${ACTIVE_TENANT_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearActiveTenantCookie(options: { secure: boolean }): string {
  return [
    `${ACTIVE_TENANT_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The raw selector, or null. Malformed values (edited, truncated) read as
 * ABSENT — the membership check downstream is what actually authorises, this
 * only refuses to carry obvious garbage any further.
 */
export function readActiveTenantCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ACTIVE_TENANT_COOKIE}=`));
  if (!raw) return null;

  let value: string;
  try {
    value = decodeURIComponent(raw.slice(ACTIVE_TENANT_COOKIE.length + 1)).trim();
  } catch {
    // Malformed percent-encoding: attacker-edited or corrupted — read as absent.
    return null;
  }
  return UUID_SHAPE.test(value) ? value : null;
}
