import { TAB_PARAM } from "@/ui/components/navigation/tab-param";

/**
 * The three views of the "Thành viên" hub. Pure and node-testable: the Server
 * Component parses `?tab=` with it before rendering, and the client hub parses
 * the same value again after every URL change — one rule, one fallback.
 *
 * `members` (who is in this company), `invites` (the links that let new people
 * in) and `history` (the audit trail of the retired approval queue). They were
 * two routes plus one block before the wave-1 IA; they are one screen with three
 * views now, so the view lives in the query (core-routing-patterns §"Path hay
 * query": cùng một trang, góc nhìn khác).
 */
export const MEMBERS_TABS = ["members", "invites", "history"] as const;

export type MembersTab = (typeof MEMBERS_TABS)[number];

/** The tab a bare `/members` opens on: who is in the company right now. */
export const DEFAULT_MEMBERS_TAB: MembersTab = "members";

export const MEMBERS_TAB_LABELS: Record<MembersTab, string> = {
  members: "Thành viên",
  invites: "Link mời",
  history: "Lịch sử duyệt",
};

/**
 * The name of the param, in one place. It is the SAME `tab` the "Bài đăng" and
 * "Kênh" hubs use — one spelling for the whole app, kept in the neutral
 * `components/navigation/tab-param` module so no hub owns another hub's URL.
 */
export const MEMBERS_TAB_PARAM = TAB_PARAM;

/**
 * Anything that is not one of the three tabs — missing, misspelt, an array from
 * a repeated `?tab=`, a hostile string — opens the default tab. A query param is
 * untrusted input: it must not be able to render a hub with no panel.
 */
export function parseMembersTab(value: unknown): MembersTab {
  if (typeof value !== "string") return DEFAULT_MEMBERS_TAB;
  return (MEMBERS_TABS as readonly string[]).includes(value)
    ? (value as MembersTab)
    : DEFAULT_MEMBERS_TAB;
}

/**
 * Which tab is on screen. The URL wins the moment the browser has one of its
 * own (Back/Forward, the redirect from `/access`, a hand-edited address); the
 * server-parsed prop only covers the first paint, when `?tab=` is ABSENT
 * (`null`) rather than empty.
 */
export function resolveActiveMembersTab(urlTab: string | null, serverTab: MembersTab): MembersTab {
  if (urlTab === null) return serverTab;
  return parseMembersTab(urlTab);
}
