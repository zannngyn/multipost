import { withTabParam } from "@/ui/components/navigation/tab-param";

/**
 * The wave-1 IA moved four screens into two hubs. This is the redirect table
 * for the addresses that disappeared — data, not a chain of `if`s, so it can be
 * read at a glance and deleted in one line once the old links are gone
 * (core-routing-patterns §"Route đã đổi").
 *
 * SECOND LINE, NOT THE ONLY ONE: since wave 2 the same four addresses are also
 * in `next.config.ts` `redirects()`, which answers 307 at the edge before any
 * page renders. These pages stay as defence in depth — a config typo, or a
 * build served without it, still lands the operator on the right hub.
 *
 * Pure and node-testable: no React, no `next/navigation` — the four redirect
 * pages and the tests all read the same table.
 */
export const LEGACY_ROUTES: Record<string, { base: string; tab: string }> = {
  "/scheduled": { base: "/posts", tab: "scheduled" },
  "/jobs": { base: "/posts", tab: "log" },
  "/channels/groups": { base: "/channels", tab: "groups" },
  "/access": { base: "/members", tab: "history" },
};

/** Old bookmarks keep working: same query, new home. Null = not a legacy path. */
export function legacyRedirectTarget(pathname: string, search: string): string | null {
  // `Object.hasOwn`, not plain indexing: the pathname is untrusted input and a
  // plain object answers "constructor" or "toString" with something inherited
  // from Object.prototype — which came back out as a redirect to
  // "undefined?tab=undefined".
  const hit = Object.hasOwn(LEGACY_ROUTES, pathname) ? LEGACY_ROUTES[pathname] : undefined;
  if (!hit) return null;
  // The one helper that spells `?tab=`, shared with every hub child that
  // rewrites a query. Hand-writing `tab=` here was a second spelling of a
  // parameter that already has an owner — and it kept a stale `?tab=` from the
  // old address, sending `/scheduled?tab=log` on to `?tab=scheduled&tab=log`.
  return `${hit.base}?${withTabParam(search, hit.tab)}`;
}
