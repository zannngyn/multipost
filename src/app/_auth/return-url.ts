/**
 * `returnUrl` sanitiser — shared by the middleware redirect and the sign-in form.
 *
 * Open-redirect guard (web-auth-flows rule 6): only same-origin PATHS are
 * accepted. `//evil.com` and `https://evil.com` are protocol-relative/absolute
 * URLs a browser would happily follow off-site, so both are rejected.
 */

export const DEFAULT_RETURN_URL = "/overview";

export function safeReturnUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_RETURN_URL;

  const candidate = value.trim();
  if (candidate.length === 0) return DEFAULT_RETURN_URL;
  if (!candidate.startsWith("/")) return DEFAULT_RETURN_URL;
  // `//host` (protocol-relative) and `/\host` (browser-normalised) leave the site.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return DEFAULT_RETURN_URL;
  // A control character or newline here means someone is probing header injection.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return DEFAULT_RETURN_URL;

  return candidate;
}
