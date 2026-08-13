"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/shared/utils";

/**
 * Primary navigation. A semantic list inside a landmark, with `aria-current`
 * on the active entry — a screen-reader user has to be able to tell where they
 * are without reading the colours (core-accessibility).
 */
const NAV_ITEMS = [
  { href: "/", label: "Tổng quan" },
  { href: "/sync", label: "Đồng bộ dữ liệu" },
  { href: "/products", label: "Sản phẩm" },
  { href: "/compose", label: "Soạn bài" },
  { href: "/bulk", label: "Chạy hàng loạt" },
  { href: "/channels", label: "Nhóm kênh" },
  { href: "/prompts", label: "Mẫu prompt" },
  { href: "/scheduled", label: "Bài đã hẹn" },
  { href: "/jobs", label: "Nhật ký đăng bài" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Điều hướng chính" className="border-b">
      <ul className="mx-auto flex w-full max-w-5xl gap-1 px-6 py-2">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
