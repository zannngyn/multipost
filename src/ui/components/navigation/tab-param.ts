/**
 * The `?tab=` parameter, for every hub that has one.
 *
 * WHY IT IS ITS OWN MODULE: "Bài đăng", "Kênh" and "Thành viên" are all one
 * screen with several views, and all three spell the view the same way. That
 * spelling used to live in `posts/posts-tabs.ts`, so the channels and members
 * hubs imported the POSTS module to learn the name of a parameter that is not
 * the posts hub's property — and the comment there said as much, in both files,
 * with a note that moving it would be one import to change. This is that move.
 *
 * Neutral on purpose: no tab list, no default, no parsing. Each hub keeps its
 * own tabs and its own fallback; only the name of the parameter, and the rule
 * for carrying it through a rebuilt query, are shared.
 */

/** The name of the param, in one place — nothing else may spell it by hand. */
export const TAB_PARAM = "tab";

/**
 * Carries `?tab=` through a query string that a CHILD screen rebuilt.
 *
 * Every screen inside a hub owns its filter in the URL and rewrites the WHOLE
 * query when it changes — which used to drop the hub's `?tab=` and bounce the
 * operator back to the default tab mid-filter. They rebuild the query with
 * their own schema helper (untouched), then hand the result here.
 *
 * `tab` goes FIRST so a shared link reads the way the redirect writes it
 * (`/posts?tab=log&status=failed`). The raw value is carried, not normalised:
 * an unknown `?tab=x` already renders the default tab, and rewriting it under
 * the operator would move the address bar for no visible reason.
 *
 * Returns a query string with no leading "?" — empty means "no query at all".
 */
export function withTabParam(search: string, tab: string | null | undefined): string {
  const rest = search.replace(/^\?/, "");
  const value = typeof tab === "string" ? tab.trim() : "";
  if (!value) return rest;

  const params = new URLSearchParams(rest);
  // A tab already inside `search` would be the child's own stale copy: the one
  // passed in is what the URL says now.
  params.delete(TAB_PARAM);
  const query = params.toString();
  const carried = `${TAB_PARAM}=${encodeURIComponent(value)}`;
  return query ? `${carried}&${query}` : carried;
}
