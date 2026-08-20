/**
 * Routes inside the app shell that do NOT need a company (M3.2).
 *
 * `/platform` is MYSP's own admin screen: a platform admin may hold no
 * membership anywhere, so sending them through the picker or the onboarding
 * screen would lock them out of the one screen they came for.
 *
 * Kept here, free of React, so the rule is greppable and testable on its own
 * rather than buried in a component — and so adding the next one (M3.3 support
 * mode) is a one-line change with a test next to it.
 */
export const TENANT_INDEPENDENT_PREFIXES = ["/platform"] as const;

/** Segment-aware: "/platformx" must not pass as "/platform". */
export function isTenantIndependentPath(pathname: string): boolean {
  const path = normalise(pathname);
  return TENANT_INDEPENDENT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function normalise(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
  return value;
}
