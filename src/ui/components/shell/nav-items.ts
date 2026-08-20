/**
 * Navigation model for the app shell. Kept free of React so the active-route
 * rule can be tested in the node environment the project already uses.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Set when another nav entry lives UNDER this one. "/channels" owns
   * "/channels/groups", which has its own entry — prefix matching would light
   * both at once and the operator could not tell which screen they are on.
   */
  readonly isExact?: boolean;
}

export interface NavSection {
  readonly title: string;
  readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    title: "Vận hành",
    items: [
      { href: "/", label: "Tổng quan" },
      { href: "/compose", label: "Soạn bài" },
      { href: "/bulk", label: "Chạy hàng loạt" },
    ],
  },
  {
    title: "Theo dõi",
    items: [
      { href: "/scheduled", label: "Bài đã hẹn" },
      { href: "/jobs", label: "Nhật ký đăng bài" },
    ],
  },
  {
    title: "Dữ liệu",
    items: [
      { href: "/products", label: "Sản phẩm" },
      { href: "/sync", label: "Đồng bộ dữ liệu" },
    ],
  },
  {
    title: "Cấu hình",
    items: [
      { href: "/channels", label: "Kênh", isExact: true },
      { href: "/channels/groups", label: "Nhóm kênh" },
      { href: "/prompts", label: "Mẫu prompt" },
      { href: "/members", label: "Thành viên" },
      // Read-only history since M2.4 — the label says so, so nobody opens it
      // expecting to add someone.
      { href: "/access", label: "Lịch sử duyệt" },
    ],
  },
] as const;

/**
 * A nav entry owns its own path and everything under it. `/batches/<id>` has no
 * nav entry of its own, so the caller may pass "/batches" to keep the log
 * section lit while a batch is open.
 *
 * Prefix matching is segment-aware on purpose: "/jobsomething" must not light
 * up "/jobs".
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
