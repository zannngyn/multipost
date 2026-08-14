# B0 — Nền Astryx + shell điều hướng dọc

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng khung Astryx cho toàn app — CSS nền, Theme, LinkProvider, route group `(app)`, và `AppShell` + `SideNav` dọc bên trái — sao cho cả 10 màn hiện có vẫn chạy y nguyên.

**Architecture:** Route group `src/app/(app)/layout.tsx` là client boundary duy nhất bọc shell; các `page.tsx` giữ nguyên vai trò Server Component lo auth. `AppShell` tự render `<main>` nên page bỏ thẻ `<main>` và container `max-w-*` của mình. Logic khớp route active tách thành module thuần để test được trong môi trường node.

**Tech Stack:** Next.js 16 App Router · React 19 · `@astryxdesign/core` 0.4.0 · `@astryxdesign/theme-neutral` 0.4.0 · `lucide-react` (icon, đã có sẵn) · Tailwind v4 (chưa nạp bridge Astryx) · vitest (environment `node`)

**Spec:** `docs/superpowers/specs/2026-08-14-redesign-ui-astryx-design.md`

## Global Constraints

- Không thêm dependency mới. Icon lấy từ `lucide-react` đã có trong `dependencies`.
- Không dùng `xstyle` (cần StyleX bundler plugin, chưa cấu hình) — chỉ props component và `className`.
- Không nạp `@astryxdesign/core/tailwind-theme.css` trong B0 (đụng token shadcn — spec 5.5).
- Không sửa `src/ui/hooks/*`, `src/ui/schemas/*`, `src/ui/services/*`. Test hiện có phải xanh nguyên.
- Import Astryx từ barrel `@astryxdesign/core` (barrel có `'use client'`), hoặc từ subpath trong file đã `"use client"`.
- Không `<div>` cho bố cục trong code mới; dùng component Astryx.
- Comment/tên biến/commit tiếng Anh; chuỗi hiển thị tiếng Việt.
- Luật phụ thuộc một chiều: `ui` không import xuống `adapters`/`db`.

---

### Task 1: Module điều hướng thuần (data + logic khớp route)

Tách danh sách mục nav và luật "mục nào đang active" ra khỏi component, để test
được trong `environment: "node"` mà không cần jsdom.

**Files:**
- Create: `src/ui/components/shell/nav-items.ts`
- Create: `src/ui/components/shell/nav-items.test.ts`

**Interfaces:**
- Produces: `NAV_SECTIONS: readonly NavSection[]` với `NavSection = { title: string; items: readonly NavItem[] }` và `NavItem = { href: string; label: string }`; `isNavItemActive(pathname: string, href: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/components/shell/nav-items.test.ts
import { describe, expect, it } from "vitest";

import { NAV_SECTIONS, isNavItemActive } from "@/ui/components/shell/nav-items";

describe("isNavItemActive", () => {
  it("marks the overview only on an exact match", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/products", "/")).toBe(false);
  });

  it("marks a section active on its own path", () => {
    expect(isNavItemActive("/products", "/products")).toBe(true);
  });

  it("marks a section active on a nested path", () => {
    expect(isNavItemActive("/batches/abc-123", "/batches")).toBe(true);
  });

  it("does not match a path that merely shares a prefix", () => {
    expect(isNavItemActive("/jobsomething", "/jobs")).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isNavItemActive("/products/", "/products")).toBe(true);
  });
});

describe("NAV_SECTIONS", () => {
  it("covers every operator destination exactly once", () => {
    const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toEqual([
      "/",
      "/compose",
      "/bulk",
      "/scheduled",
      "/jobs",
      "/products",
      "/sync",
      "/channels",
      "/prompts",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ui/components/shell/nav-items.test.ts`
Expected: FAIL — không resolve được `@/ui/components/shell/nav-items`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/ui/components/shell/nav-items.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ui/components/shell/nav-items.test.ts`
Expected: PASS — 6 test

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/shell/nav-items.ts src/ui/components/shell/nav-items.test.ts
git commit -m "feat(ui): navigation model with segment-aware active matching"
```

---

### Task 2: Nạp CSS nền Astryx

**Files:**
- Modify: `src/app/globals.css:1-3`

**Interfaces:**
- Produces: token Astryx (`--color-text-primary`, `--color-background-surface`, …) có mặt trên `:root`; token shadcn giữ nguyên.

- [ ] **Step 1: Thêm khai báo layer và import Astryx**

Sửa ba dòng đầu `src/app/globals.css` thành:

```css
/* Layer order per `astryx docs styling`. The Astryx Tailwind bridge is
   deliberately NOT imported yet: it remaps --color-primary/--color-card/
   --color-muted to different meanings and would break every shadcn utility
   still in use. It lands in B9, once the last screen stops using them. */
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;

@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@import "@astryxdesign/core/reset.css";
@import "@astryxdesign/core/astryx.css";
@import "@astryxdesign/theme-neutral/theme.css";
```

Giữ nguyên toàn bộ phần còn lại của file (`@custom-variant`, `@theme inline`, `:root`, `.dark`, `@layer base`).

- [ ] **Step 2: Verify build sinh ra CSS có token Astryx**

Run: `pnpm build`
Expected: exit 0.

Run: `grep -rl "color-background-surface" .next/static/css | head -1`
Expected: in ra một đường dẫn file CSS — token Astryx đã thật sự vào bundle, không chỉ build xanh.

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(ui): load Astryx reset, core and neutral theme CSS"
```

---

### Task 3: Shell component (SideNav + AppShell)

**Files:**
- Create: `src/ui/components/shell/AppSideNav.tsx`
- Create: `src/ui/components/shell/AppFrame.tsx`

**Interfaces:**
- Consumes: `NAV_SECTIONS`, `isNavItemActive` từ Task 1
- Produces: `AppFrame({ children, operatorLabel, signOutAction }: { children: ReactNode; operatorLabel: string; signOutAction: ReactNode })`

- [ ] **Step 1: Viết `AppSideNav`**

```tsx
// src/ui/components/shell/AppSideNav.tsx
"use client";

import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core";
import {
  CalendarClock,
  FolderSync,
  LayoutDashboard,
  Layers,
  ListChecks,
  PenLine,
  Radio,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { NAV_SECTIONS, isNavItemActive } from "@/ui/components/shell/nav-items";

/**
 * Primary navigation. Astryx has no domain icons in its semantic registry
 * (only 28 utility names), and `IconType` accepts a component, so these come
 * from lucide-react, which the project already depends on.
 */
const ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  "/": LayoutDashboard,
  "/compose": PenLine,
  "/bulk": Layers,
  "/scheduled": CalendarClock,
  "/jobs": ScrollText,
  "/products": ListChecks,
  "/sync": FolderSync,
  "/channels": Radio,
  "/prompts": Sparkles,
};

export function AppSideNav({ footer }: { footer: ReactNode }) {
  const pathname = usePathname();

  return (
    <SideNav
      collapsible
      resizable={{ defaultWidth: 256, minWidth: 240, maxWidth: 280, autoSaveId: "mysp-nav" }}
      footer={footer}
    >
      {NAV_SECTIONS.map((section) => (
        <SideNavSection key={section.title} title={section.title}>
          {section.items.map((item) => (
            <SideNavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={ICONS[item.href]}
              // The batch detail page has no nav entry of its own; keep the log
              // section lit while one is open.
              isSelected={
                isNavItemActive(pathname, item.href) ||
                (item.href === "/jobs" && isNavItemActive(pathname, "/batches"))
              }
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
```

- [ ] **Step 2: Viết `AppFrame`**

```tsx
// src/ui/components/shell/AppFrame.tsx
"use client";

import { AppShell, LinkProvider, Text, Theme, VStack } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { AppSideNav } from "@/ui/components/shell/AppSideNav";

/**
 * The app's single client boundary for the shell. Pages stay Server Components
 * and keep owning the session guard; they pass their rendered content in.
 *
 * AppShell renders its own <main>, so pages must not render one themselves.
 */
export function AppFrame({
  children,
  operatorLabel,
  signOutAction,
}: {
  children: ReactNode;
  operatorLabel: string;
  signOutAction: ReactNode;
}) {
  return (
    <LinkProvider component={NextLink}>
      <Theme theme={neutralTheme}>
        <AppShell
          contentPadding={0}
          sideNav={
            <AppSideNav
              footer={
                <VStack gap={1}>
                  <Text size="sm" weight="medium">
                    {operatorLabel}
                  </Text>
                  {signOutAction}
                </VStack>
              }
            />
          }
        >
          {children}
        </AppShell>
      </Theme>
    </LinkProvider>
  );
}
```

- [ ] **Step 3: Đối chiếu prop với CLI trước khi tin**

Run: `pnpm exec astryx component SideNavSection` — xác nhận tên prop tiêu đề section.
Run: `pnpm exec astryx component LinkProvider` — xác nhận tên prop nhận component link.
Run: `pnpm exec astryx component Text` — xác nhận `size`/`weight` hợp lệ.
Run: `pnpm exec astryx component VStack` — xác nhận `gap`.

Sửa code theo đúng prop thật nếu lệch. **Không đoán tên prop.**

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/shell/AppSideNav.tsx src/ui/components/shell/AppFrame.tsx
git commit -m "feat(ui): Astryx app shell with left side navigation"
```

---

### Task 4: Route group `(app)` và layout dùng chung

**Files:**
- Create: `src/app/(app)/layout.tsx`
- Move: `src/app/{page.tsx,compose,bulk,scheduled,jobs,products,sync,channels,prompts,batches}` → `src/app/(app)/…`

**Interfaces:**
- Consumes: `AppFrame` từ Task 3
- Produces: mọi route dưới `(app)` được bọc shell; URL không đổi.

- [ ] **Step 1: Di chuyển bằng `git mv` để giữ lịch sử**

```bash
mkdir -p "src/app/(app)"
git mv src/app/page.tsx "src/app/(app)/page.tsx"
for dir in compose bulk scheduled jobs products sync channels prompts batches; do
  git mv "src/app/$dir" "src/app/(app)/$dir"
done
```

`src/app/signin`, `src/app/_auth`, `src/app/api`, `layout.tsx`, `providers.tsx`, `error.tsx`, `global-error.tsx`, `globals.css` **ở nguyên chỗ cũ**.

- [ ] **Step 2: Viết layout của route group**

```tsx
// src/app/(app)/layout.tsx
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { signOut } from "@/app/_auth/auth";
import { getOperatorSession } from "@/app/_auth/session";
import { AppFrame } from "@/ui/components/shell/AppFrame";
import { SignOutButton } from "@/ui/components/shell/SignOutButton";

/** Session-dependent: never prerendered, never cached by a proxy. */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getOperatorSession("layout:(app)");

  // Defence in depth: middleware already blocks these routes, but a Server
  // Component must not trust that it was reached through the guard.
  if (!session) redirect("/signin");

  return (
    <AppFrame
      operatorLabel={session.name ?? session.email}
      signOutAction={
        session.isDevFake ? null : (
          <form
            action={async () => {
              "use server";
              // signOut() throws NEXT_REDIRECT — keep it out of try/catch.
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <SignOutButton />
          </form>
        )
      }
    >
      {children}
    </AppFrame>
  );
}
```

- [ ] **Step 3: Viết `SignOutButton`**

Astryx `Button` cần `label` và không có `asChild`; nút submit của form phải là client component riêng để dùng được trong form action của Server Component.

```tsx
// src/ui/components/shell/SignOutButton.tsx
"use client";

import { Button } from "@astryxdesign/core";

export function SignOutButton() {
  return <Button type="submit" variant="ghost" size="sm" label="Đăng xuất" />;
}
```

- [ ] **Step 4: Gỡ `<AppNav />` và container khỏi từng page**

Trong cả 10 file `src/app/(app)/**/page.tsx`:
- xoá dòng `import { AppNav } from "@/ui/components/nav/AppNav";`
- xoá `<AppNav />`
- thay `<main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">…</main>` bằng chính nội dung bên trong (AppShell đã render `<main>`; lồng `<main>` trong `<main>` là lỗi a11y)
- bỏ luôn fragment `<>…</>` nếu chỉ còn một con

Riêng `src/app/(app)/page.tsx`: xoá cả khối `<header>` chứa tên người đăng nhập và nút Đăng xuất — hai thứ đó đã chuyển xuống footer của SideNav.

- [ ] **Step 5: Xoá `AppNav`**

```bash
git rm src/ui/components/nav/AppNav.tsx
```

Run: `grep -rn "AppNav" src/`
Expected: không còn kết quả.

- [ ] **Step 6: Verify**

Run: `pnpm verify`
Expected: exit 0 ở cả 5 chặng (typecheck · lint · depcruise · test · build).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ui): move app routes into an (app) group behind one shell"
```

---

### Task 5: Kiểm chứng thật trên trình duyệt

Build xanh không chứng minh shell render đúng. Bước này bắt buộc trước khi coi B0 là xong.

- [ ] **Step 1: Chạy dev server ở port riêng**

```bash
pnpm dev --port 3005 &
echo $!    # lưu PID, dừng bằng kill "$PID" — không dùng pkill
```

- [ ] **Step 2: Kiểm 3 điều trên `http://localhost:3005`**

1. SideNav dọc hiện bên trái với đủ 4 section và 9 mục.
2. Bấm qua lại giữa các mục: URL đổi, mục đúng được tô sáng, không tải lại cả trang (LinkProvider hoạt động).
3. Mở `/batches/<id>` bất kỳ từ Nhật ký: mục "Nhật ký đăng bài" vẫn sáng.

- [ ] **Step 3: Kiểm không có `<main>` lồng nhau**

Trong console trình duyệt: `document.querySelectorAll("main").length`
Expected: `1`

- [ ] **Step 4: Dừng dev server**

```bash
kill "$PID"
```

- [ ] **Step 5: Commit nếu có sửa**

---

## Điều kiện thoát B0

- `pnpm verify` exit 0.
- `grep -rn "AppNav" src/` không còn kết quả.
- Cả 9 route trong nav mở được, mục active đúng, điều hướng không reload trang.
- Đúng một `<main>` trên mỗi trang.
- Chưa nạp `tailwind-theme.css`; các màn vẫn dùng token shadcn như cũ.

## Sau B0

B1 (Sản phẩm) chốt pattern rows + inspector rồi mới viết plan cho B2–B8. Viết
trước sẽ là đoán, vì tên component dùng lại sinh ra từ B1.
