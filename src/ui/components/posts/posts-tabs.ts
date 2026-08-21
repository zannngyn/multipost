import { TAB_PARAM, withTabParam } from "@/ui/components/navigation/tab-param";

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

/**
 * The `?tab=` name and the carry rule now live in
 * `components/navigation/tab-param.ts` — they belong to every hub, not to this
 * one. Re-exported under the old names so the screens inside "Bài đăng" keep
 * their import.
 */
export const POSTS_TAB_PARAM = TAB_PARAM;
export { withTabParam };

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
