/**
 * Navigation model for the app shell. Kept free of React so the active-route
 * rule can be tested in the node environment the project already uses.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Set when another nav entry lives UNDER this one: prefix matching would
   * light both at once and the operator could not tell which screen they are
   * on.
   *
   * `/platform` is the first entry to need it (M3.4 put "Màu giao diện" at
   * `/platform/appearance`) — the case the mechanism was kept for.
   */
  readonly isExact?: boolean;
}

export interface NavSection {
  readonly title: string;
  readonly items: readonly NavItem[];
  /**
   * Only for accounts that hold a platform role (M3.2). This is the first
   * permission-filtered part of the nav, and it closes ticket N3 ("nav hiện mục
   * cho người không có quyền") for this section.
   *
   * HIDDEN, not disabled: an operator of a customer company has no business
   * knowing MYSP has an internal admin screen, and there is nothing they could
   * ask for to gain access (core-auth-session §cây quyết định: ẩn hoàn toàn khi
   * biết nó tồn tại cũng là rò rỉ).
   */
  readonly requiresPlatformRole?: boolean;
}

/**
 * The wave-1 information architecture: five groups an operator can name, each
 * answering one question — where do I start, what do I publish, what happened,
 * what is it built from, how is it set up.
 *
 * Ten destinations, down from thirteen: "/posts" absorbs the scheduled list and
 * the publish log (one list, filtered), channel groups moved inside "/channels",
 * and the approval history became a tab of "/members" — three fewer rows to read
 * past, and no screen removed.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { title: "Bàn làm việc", items: [{ href: "/overview", label: "Tổng quan" }] },
  {
    title: "Đăng bài",
    items: [
      { href: "/compose", label: "Soạn bài" },
      { href: "/bulk", label: "Chạy hàng loạt" },
    ],
  },
  { title: "Theo dõi", items: [{ href: "/posts", label: "Bài đăng" }] },
  {
    title: "Dữ liệu",
    items: [
      { href: "/products", label: "Sản phẩm" },
      { href: "/sync", label: "Đồng bộ dữ liệu" },
      { href: "/data-mapping", label: "Kết nối dữ liệu" },
    ],
  },
  {
    title: "Cài đặt",
    items: [
      { href: "/channels", label: "Kênh" },
      { href: "/prompts", label: "Mẫu prompt" },
      { href: "/members", label: "Thành viên" },
    ],
  },
  {
    title: "Nền tảng",
    requiresPlatformRole: true,
    items: [
      // `isExact` earns its keep here: "/platform/appearance" lives UNDER
      // "/platform", so prefix matching would light both rows at once and the
      // operator could not tell which screen they are on. This is the nested
      // destination the mechanism was built for (M3.4).
      { href: "/platform", label: "Công ty khách", isExact: true },
      { href: "/platform/appearance", label: "Màu giao diện" },
    ],
  },
] as const;

export interface NavVisibility {
  /** `account.platformRole !== null` from /api/me. */
  readonly hasPlatformRole: boolean;
}

/**
 * The sections this account may see.
 *
 * Called with `hasPlatformRole: false` while `/api/me` is still loading, so the
 * privileged group is never rendered and then yanked away — a menu item that
 * appears for a moment is a menu item somebody clicks (core-auth-session: menu
 * chờ biết quyền mới render, chống nháy hiện-rồi-biến-mất).
 *
 * Hiding is NOT the protection: `/platform` guards itself server-side, because
 * "ẩn khỏi menu nhưng gõ thẳng URL vẫn vào được" is the classic hole.
 */
export function visibleNavSections(
  visibility: NavVisibility,
  sections: readonly NavSection[] = NAV_SECTIONS,
): readonly NavSection[] {
  return sections.filter(
    (section) => !section.requiresPlatformRole || visibility.hasPlatformRole,
  );
}

/**
 * A nav entry owns its own path and everything under it. `/batches/<id>` has no
 * nav entry of its own, so the caller may pass "/batches" to keep "Bài đăng"
 * lit while a batch is open.
 *
 * Prefix matching is segment-aware on purpose: "/postsomething" must not light
 * up "/posts".
 *
 * `exact` turns the prefix rule off for an entry whose sub-paths belong to a
 * different entry (see `NavItem.isExact`).
 */
export function isNavItemActive(
  pathname: string,
  href: string,
  options?: { exact?: boolean },
): boolean {
  const path = normalise(pathname);
  const target = normalise(href);

  if (target === "/") return path === "/";
  if (options?.exact) return path === target;
  return path === target || path.startsWith(`${target}/`);
}

/** Drops a trailing slash so "/products/" and "/products" compare equal. */
function normalise(value: string): string {
  if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
  return value;
}

/** One nav entry plus the section it came from, flattened for search. */
export interface FlatNavItem {
  readonly href: string;
  readonly label: string;
  readonly section: string;
}

/**
 * The nav tree as a flat list. The section title travels with each entry so the
 * command palette can group results the way the sidebar already groups them —
 * one destination list, two renderings.
 */
export function flattenNavItems(
  sections: readonly NavSection[] = NAV_SECTIONS,
): readonly FlatNavItem[] {
  return sections.flatMap((section) =>
    section.items.map((item) => ({
      href: item.href,
      label: item.label,
      section: section.title,
    })),
  );
}

/**
 * Diacritic-free lower-case key. Operators type Vietnamese without tone marks
 * far more often than with them, so "dong bo" has to find "Đồng bộ dữ liệu";
 * substring matching on the raw label never would.
 *
 * NFD splits the tone marks off into the combining range, but leaves đ/Đ whole
 * — those are separate letters, not accented d, and need their own pass.
 */
export function toSearchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}
