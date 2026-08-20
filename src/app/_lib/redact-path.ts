/**
 * Pathname redaction for LOG LINES (M2.2 gate fix, B1). Pure and edge-safe:
 * imported by `src/proxy.ts`, so nothing beyond string work may ever live here.
 *
 * Why it exists: `/join/<token>` carries a BEARER — an invite token that grants
 * a membership — and /join is deliberately NOT public (redeeming requires a
 * session). A signed-out colleague clicking their invite link therefore hits
 * the deny path first, and logging that request's pathname verbatim would put
 * the token in front of everyone who can read logs — people who are not
 * members of the tenant the token admits to. The BROWSER must keep the full
 * path (the signin→join round trip has to close); only the LOG loses it.
 *
 * One list, one function: the next token-bearing path gets added HERE, not as
 * another ad-hoc replace at a call site.
 */

/** Path prefixes whose NEXT segment is a secret. */
const SENSITIVE_PREFIXES = ["/join"] as const;

const REDACTED = "<redacted>";

export function redactSensitivePath(pathname: string): string {
  // Guard: never throw over a log line — garbage in, something loggable out.
  if (typeof pathname !== "string" || pathname.length === 0) return pathname;

  for (const prefix of SENSITIVE_PREFIXES) {
    if (pathname === prefix) return pathname; // no segment, nothing to hide
    if (pathname.startsWith(`${prefix}/`)) {
      // Everything after the prefix is treated as secret, including any
      // deeper segments — err on the side of hiding too much in a log.
      return `${prefix}/${REDACTED}`;
    }
  }
  return pathname;
}
