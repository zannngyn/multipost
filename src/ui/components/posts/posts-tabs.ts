/**
 * The two views of the "Bài đăng" hub. Pure and node-testable: the Server
 * Component parses `?tab=` with it before rendering, and the client hub parses
 * the same value again after every URL change — one rule, one fallback.
 */
export const POSTS_TABS = ["scheduled", "log"] as const;

export type PostsTab = (typeof POSTS_TABS)[number];

/** The tab a bare `/posts` opens on: what is about to go out matters most. */
export const DEFAULT_POSTS_TAB: PostsTab = "scheduled";

export const POSTS_TAB_LABELS: Record<PostsTab, string> = {
  scheduled: "Bài đã hẹn",
  log: "Nhật ký đăng",
};

/**
 * Anything that is not one of the two tabs — missing, misspelt, an array from a
 * repeated `?tab=`, a hostile string — opens the default tab. A query param is
 * untrusted input: it must not be able to render an empty screen.
 */
export function parsePostsTab(value: unknown): PostsTab {
  if (typeof value !== "string") return DEFAULT_POSTS_TAB;
  return (POSTS_TABS as readonly string[]).includes(value) ? (value as PostsTab) : DEFAULT_POSTS_TAB;
}

/** The name of the param, in one place — nothing else may spell it by hand. */
export const POSTS_TAB_PARAM = "tab";

/**
 * Which tab is on screen. The URL wins the moment the browser has one of its
 * own (Back/Forward, the redirect from `/jobs`, a hand-edited address); the
 * server-parsed prop only covers the first paint, when `?tab=` is ABSENT
 * (`null`) rather than empty.
 *
 * Pure so the rule can be tested without rendering: `PostsHub` is the only
 * caller and passes `searchParams.get("tab")` straight in.
 */
export function resolveActiveTab(urlTab: string | null, serverTab: PostsTab): PostsTab {
  if (urlTab === null) return serverTab;
  return parsePostsTab(urlTab);
}

/**
 * Carries `?tab=` through a query string that a CHILD screen rebuilt.
 *
 * Both screens own their filter in the URL and rewrite the whole query when it
 * changes — which used to drop the hub's `?tab=` and bounce the operator back
 * to the scheduled tab mid-filter. They rebuild the query with their own schema
 * helper (untouched), then hand the result here.
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
  params.delete(POSTS_TAB_PARAM);
  const query = params.toString();
  const carried = `${POSTS_TAB_PARAM}=${encodeURIComponent(value)}`;
  return query ? `${carried}&${query}` : carried;
}
