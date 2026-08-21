/**
 * The wave-1 IA moved four screens into two hubs. This is the redirect table
 * for the addresses that disappeared — data, not a chain of `if`s, so it can be
 * read at a glance and deleted in one line once the old links are gone
 * (core-routing-patterns §"Route đã đổi").
 *
 * Pure and node-testable: no React, no `next/navigation` — the three redirect
 * pages and the tests all read the same table.
 */
const LEGACY: Record<string, { base: string; tab: string }> = {
  "/scheduled": { base: "/posts", tab: "scheduled" },
  "/jobs": { base: "/posts", tab: "log" },
  "/channels/groups": { base: "/channels", tab: "groups" },
  "/access": { base: "/members", tab: "history" },
};

/** Old bookmarks keep working: same query, new home. Null = not a legacy path. */
export function legacyRedirectTarget(pathname: string, search: string): string | null {
  const hit = LEGACY[pathname];
  if (!hit) return null;
  const rest = search.replace(/^\?/, "");
  return `${hit.base}?tab=${hit.tab}${rest ? `&${rest}` : ""}`;
}
