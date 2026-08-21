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
