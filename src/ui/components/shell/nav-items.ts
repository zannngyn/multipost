/**
 * Navigation model for the app shell. Kept free of React so the active-route
 * rule can be tested in the node environment the project already uses.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
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
      { href: "/channels", label: "Nhóm kênh" },
      { href: "/prompts", label: "Mẫu prompt" },
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
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  const path = normalise(pathname);
  const target = normalise(href);

  if (target === "/") return path === "/";
  return path === target || path.startsWith(`${target}/`);
}

/** Drops a trailing slash so "/products/" and "/products" compare equal. */
function normalise(value: string): string {
  if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
  return value;
}
