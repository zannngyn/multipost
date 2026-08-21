import { POSTS_TAB_PARAM, withTabParam } from "@/ui/components/posts/posts-tabs";

/**
 * The three views of the "Kênh" hub. Pure and node-testable: the Server
 * Component parses `?tab=` with it before rendering, and the client hub parses
 * the same value again after every URL change — one rule, one fallback.
 *
 * `pages` (what can I publish to), `groups` (the shortcuts built on top of that
 * list) and `connect` (adding more). They were two routes before the wave-1 IA;
 * they are one screen with three views now, so the view lives in the query
 * (core-routing-patterns §"Path hay query": cùng một trang, góc nhìn khác).
 */
export const CHANNELS_TABS = ["pages", "groups", "connect"] as const;

export type ChannelsTab = (typeof CHANNELS_TABS)[number];

/** The tab a bare `/channels` opens on: what is connected right now. */
export const DEFAULT_CHANNELS_TAB: ChannelsTab = "pages";

export const CHANNELS_TAB_LABELS: Record<ChannelsTab, string> = {
  pages: "Page đã kết nối",
  groups: "Nhóm kênh",
  connect: "Kết nối thêm",
};

/**
 * The name of the param, in one place. It is the SAME `tab` the "Bài đăng" hub
 * uses — one spelling for the whole app, so `withTabParam` below works for both
 * (and so a future move of these two helpers to a neutral module is one import
 * to change, not a search for the string "tab").
 */
export const CHANNELS_TAB_PARAM = POSTS_TAB_PARAM;

/**
 * Anything that is not one of the three tabs — missing, misspelt, an array from
 * a repeated `?tab=`, a hostile string — opens the default tab. A query param is
 * untrusted input: it must not be able to render a hub with no panel.
 */
export function parseChannelsTab(value: unknown): ChannelsTab {
  if (typeof value !== "string") return DEFAULT_CHANNELS_TAB;
  return (CHANNELS_TABS as readonly string[]).includes(value)
    ? (value as ChannelsTab)
    : DEFAULT_CHANNELS_TAB;
}

/**
 * Which tab is on screen. The URL wins the moment the browser has one of its
 * own (Back/Forward, the redirect from `/channels/groups`, a hand-edited
 * address); the server-parsed prop only covers the first paint, when `?tab=` is
 * ABSENT (`null`) rather than empty.
 */
export function resolveActiveChannelsTab(
  urlTab: string | null,
  serverTab: ChannelsTab,
): ChannelsTab {
  if (urlTab === null) return serverTab;
  return parseChannelsTab(urlTab);
}

/**
 * The parameters the Facebook callback writes on its way back to `/channels`.
 *
 * Spelt here as well as in `parseConnectOutcome` (schemas are out of this
 * change's reach), so `channels-tabs.test.ts` pins the two together: it asserts
 * that after this strip, `parseConnectOutcome` reads nothing at all.
 */
const CONNECT_CALLBACK_PARAMS = ["connected", "connect", "reason"] as const;

/**
 * Drops the OAuth callback params and keeps everything else.
 *
 * The callback message is read into state once and the URL is then rewritten,
 * so a reload cannot replay "Đã kết nối 2 Page" hours later (web-auth-methods
 * §4). Rewriting to the bare pathname would have taken the hub's `?tab=` with
 * it — hence a strip, not a wipe.
 *
 * Returns a query string with no leading "?" — empty means "no query at all".
 */
export function withoutConnectParams(search: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  for (const name of CONNECT_CALLBACK_PARAMS) params.delete(name);
  return params.toString();
}

/**
 * The query the hub replaces the URL with after reading an OAuth callback:
 * callback params gone, tab kept, everything else untouched.
 *
 * The tab is NORMALISED here (unlike the posts hub, which carries the raw
 * value): this rewrite already moves the address bar, so leaving `?tab=bogus`
 * in it would keep an address that does not describe what is on screen.
 */
export function channelsHubQuery(search: string): string {
  const rest = withoutConnectParams(search);
  const tab = parseChannelsTab(new URLSearchParams(rest).get(CHANNELS_TAB_PARAM));
  return withTabParam(rest, tab);
}
