/**
 * The session guard's PUBLIC allowlist (edge-safe, pure — imported by
 * `src/proxy.ts`). Everything not matched here requires a session.
 */

/** Public prefixes: the path itself plus its sub-paths. */
const PUBLIC_PREFIXES = [
  "/signin", // the door itself — must stay outside the guard, or redirect loop
  "/api/auth", // Auth.js flow endpoints
  "/api/health", // liveness probe for Docker/Caddy, called without a session
] as const;

/**
 * The ONE public media route — tier P (doc 10 §2): Meta's fetcher downloads
 * the photo with no cookie at all, so a session guard would break every
 * Facebook post; its bearer is the HMAC in `?sig=`, verified inside
 * `getMediaContent`. EXACTLY `/api/media/<one-segment>` and nothing deeper:
 * a bare `/api/media` prefix once swallowed `/api/media/preview/**` (the
 * SESSION-backed compose bridge) into the public allowlist by accident. That
 * route self-authorises, but public-by-accident is how the in-handler check
 * gets deleted one day by someone who trusts the middleware.
 */
const PUBLIC_MEDIA_PATH = /^\/api\/media\/[^/]+$/;

export function isPublicPath(pathname: string): boolean {
  // The session-backed compose bridge lives UNDER /api/media — carve the whole
  // subtree out before the one-segment shape can claim `/api/media/preview`
  // itself ("preview" is, after all, one segment).
  if (pathname === "/api/media/preview" || pathname.startsWith("/api/media/preview/")) {
    return false;
  }
  if (PUBLIC_MEDIA_PATH.test(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
