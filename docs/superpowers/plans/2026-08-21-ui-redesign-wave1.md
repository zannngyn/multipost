# UI Redesign "Sổ mẫu vải" — Đợt 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Flow repo (CLAUDE.md):** orchestrator giao từng task cho agent `ui-web`; sau mỗi task, gate `reviewer-qa` phải PASS (review diff + output verify thật) trước khi sang task kế. Không có ngoại lệ.

**Goal:** Đợt 1 của redesign UI: theme token "Sổ mẫu vải" + IA mới (nav 5 nhóm, 3 cặp redirect, tab hub) + màn Tổng quan mới + bố cục lại màn Soạn bài — không đụng logic.

**Architecture:** Chỉ sửa tầng trình bày. Token semantic trong `src/app/globals.css` giữ nguyên TÊN biến (đổi giá trị → mọi component ăn theme mới không cần sửa). IA đổi ở `nav-items.ts` + route mới `/posts` + redirect route-level. Màn gộp tab tái dùng nguyên screen component hiện có. Compose chỉ di chuyển JSX/bố cục, hooks giữ nguyên.

**Tech Stack:** Next.js 16 App Router, Astryx v0.4.0 (`@astryxdesign/core`), Tailwind v4 token-first, vitest (node env cho logic test), TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-21-ui-redesign-design.md` (đọc trước khi làm bất kỳ task nào — direction contract, 4 raise, ranh giới Operate nằm ở đó).

## Global Constraints

- KHÔNG sửa: `src/ui/hooks/**`, `src/ui/services/**`, `src/ui/schemas/**`, `src/app/api/**`, `src/core/**`, `src/adapters/**`, `src/worker/**`. Ngoại lệ duy nhất: file logic thuần cạnh component (`channel-picker.ts`, `nav-items.ts`…) trong `src/ui/components/**`.
- Mọi màu/radius/spacing qua token semantic — không hex/px trần trong component; token mới viết bằng oklch, đủ cặp light/dark.
- Không thêm dependency. Không import `@astryxdesign/core/tailwind-theme.css` (ghi chú đầu `globals.css` — mốc B9).
- Chữ: giữ Be Vietnam Pro + JetBrains Mono (subset vietnamese bắt buộc — The Diacritics Rule).
- 4 raise của direction contract là luật: phân cấp bằng cỡ chữ không bằng hộp màu · đang chạy thì động, đã chốt đứng im · một sự kiện motion mỗi thời điểm · mật độ reflow theo bậc container query.
- Giữ nguyên hành vi mọi state có sẵn: loading delay 300ms, empty first-run vs no-result, error 4xx/5xx, stale, read-only support mode.
- UI copy tiếng Việt; code/comment/commit tiếng Anh.
- Lệnh verify chuẩn của repo: `pnpm verify` (= typecheck + lint + depcruise + test + build). Từng task chạy tối thiểu `pnpm test` + `pnpm typecheck`; task cuối chạy `pnpm verify` đầy đủ.
- Làm trên branch `redesign/swatch-book-w1` (tạo ở Task 1). Commit theo từng task; KHÔNG push/tạo PR cho tới Task 9.

---

### Task 1: Branch + theme token "Sổ mẫu vải" + direction contract

**Files:**
- Modify: `src/app/globals.css` (khối `:root` và `.dark` — chỉ đổi GIÁ TRỊ, giữ nguyên tên biến)
- Modify: `src/app/layout.tsx` (chèn direction contract comment làm con đầu tiên của `<body>`)

**Interfaces:**
- Produces: bộ giá trị token mới mà mọi task sau mặc nhiên dùng qua các class sẵn có (`bg-background`, `text-foreground`, `border`, `bg-primary`…). Không có API mới.

- [ ] **Step 1: Tạo branch**

```bash
git checkout dev && git pull && git checkout -b redesign/swatch-book-w1
```

- [ ] **Step 2: Đổi giá trị token light trong `globals.css`**

Trong khối `:root`, thay các giá trị (giữ nguyên tên biến và comment structure; cập nhật nội dung comment mô tả sang thế giới mới):

```css
:root {
  color-scheme: light;
  /* Swatch-book world: unbleached muslin ground, warm ink, indigo-dye action,
     madder/turmeric/leaf status hues. Values are wave-1 starting points; the
     bounded inspect round may tune lightness only, never semantics. */
  --background: oklch(0.955 0.013 84);            /* vải mộc */
  --foreground: oklch(0.28 0.018 55);             /* mực nâu đen ấm */
  --foreground-subtle: oklch(0.62 0.02 60);
  --card: oklch(0.984 0.007 84);
  --card-foreground: oklch(0.28 0.018 55);
  --popover: oklch(0.984 0.007 84);
  --popover-foreground: oklch(0.28 0.018 55);
  --primary: oklch(0.45 0.105 262);               /* chàm — indigo dye */
  --primary-foreground: oklch(0.984 0.007 84);
  --secondary: oklch(0.933 0.014 84);
  --secondary-foreground: oklch(0.28 0.018 55);
  --muted: oklch(0.933 0.014 84);
  --muted-foreground: oklch(0.47 0.02 58);
  --accent: oklch(0.89 0.045 262);                /* thẻ đang chọn — chàm nhạt */
  --accent-foreground: oklch(0.38 0.11 263);
  --destructive: oklch(0.54 0.15 30);             /* madder red */
  --warning: oklch(0.76 0.12 75);                 /* turmeric */
  --warning-foreground: oklch(0.49 0.10 68);
  --success: oklch(0.68 0.11 160);                /* leaf */
  --success-foreground: oklch(0.50 0.09 163);
  --info: oklch(0.60 0.10 255);
  --info-foreground: oklch(0.47 0.11 257);
  --media-empty: oklch(0.92 0.02 84);
  --media-empty-cover: oklch(0.90 0.025 80);
  --border: oklch(0.28 0.018 55 / 12%);
  --input: oklch(0.28 0.018 55 / 16%);
  --ring: oklch(0.45 0.105 262 / 45%);
  --radius: 0.5rem;                                /* cạnh cắt vải — vuông vức hơn pastel cũ */
  /* ... giữ nguyên các biến còn lại trong khối (chart-*, sidebar-*) nhưng map
     sidebar về card/accent mới; chart-1..5 map theo primary/info/success/warning/destructive. */
}
```

- [ ] **Step 3: Đổi khối `.dark` tương ứng** (cùng ngữ nghĩa, nền tối ấm; primary sáng lên để đủ tương phản)

```css
.dark {
  color-scheme: dark;
  --background: oklch(0.24 0.012 60);
  --foreground: oklch(0.94 0.01 84);
  --card: oklch(0.28 0.014 60);
  --primary: oklch(0.68 0.09 262);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 16%);
  /* ... các biến còn lại theo cùng công thức: giữ hue, đảo lightness; status
     hues giữ phân biệt được ở tint 10% trên nền tối. */
}
```

- [ ] **Step 4: Chèn direction contract vào `src/app/layout.tsx`** — HTML comment là con đầu tiên của `<body>` (new-work §5, ≤150 từ):

```tsx
<body ...>
  {/* eslint-disable-next-line react/jsx-no-comment-textnodes */}
  <div hidden aria-hidden="true" data-direction-contract dangerouslySetInnerHTML={{ __html: `<!--
THESIS: MYSP la so mau vai cua xuong: moi mau la mot the vai, moi ma san pham mot trang mau; tu choi admin-SaaS card trang + accent tim rai deu.
OWN-WORLD: nen vai moc oklch(0.955 0.013 84), muc am, cham indigo hanh dong, the mau bao hoa canh bac thang, nhan det mono cho ma/so.
STORY: nguoi van hanh mo so mau, thay viec hom nay, rut the soan bai, duyet caption, luon tra loi duoc "vi sao bai nay khong len".
FIRST VIEWPORT: hang so lieu tren nhan det (bam duoc) + viec can chu y + chong the lo dang chay; mot hanh dong chinh "Soan bai moi".
FORM: grounded #4 vong 2, seed e06531fb.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->` }} />
```

(Nếu root layout hiện tại là server component thuần, dùng đúng cấu trúc trên; sau `pnpm build` grep chuỗi `e06531fb` trong `.next/` để xác nhận contract sống sót qua build.)

- [ ] **Step 5: Verify + commit**

```bash
pnpm typecheck && pnpm test && pnpm build && grep -rl "e06531fb" .next/ | head -1
git add src/app/globals.css src/app/layout.tsx
git commit -m "feat(ui): swatch-book theme tokens and direction contract"
```

Expected: typecheck/test/build PASS; grep tìm thấy ít nhất 1 file. Mở `pnpm dev` xem nhanh: toàn app đổi sang nền vải mộc + chàm, không màn nào vỡ (vì tên token không đổi).

---

### Task 2: Nav model mới (5 nhóm / 10 mục)

**Files:**
- Modify: `src/ui/components/shell/nav-items.ts`
- Modify: `src/ui/components/shell/nav-items.test.ts`
- Modify: `src/ui/components/shell/AppSideNav.tsx` (mục sáng khi ở `/batches/*` đổi từ `/jobs` sang `/posts`)

**Interfaces:**
- Produces: `NAV_SECTIONS` mới — Task 3/4/5 tạo các route mà nav này trỏ tới (`/posts`; `/channels` và `/members` bỏ mục con). Command palette (`AppSearch`) tự ăn theo, không cần sửa.

- [ ] **Step 1: Sửa test trước** — trong `nav-items.test.ts`, cập nhật các assert cấu trúc:

```ts
it("has the wave-1 IA: 5 visible groups, 10 destinations, platform gated", () => {
  const sections = visibleNavSections({ hasPlatformRole: true });
  expect(sections.map((s) => s.title)).toEqual([
    "Bàn làm việc", "Đăng bài", "Theo dõi", "Dữ liệu", "Cài đặt", "Nền tảng",
  ]);
  expect(sections.flatMap((s) => s.items.map((i) => i.href))).toEqual([
    "/", "/compose", "/bulk", "/posts", "/products", "/sync",
    "/channels", "/prompts", "/members", "/platform",
  ]);
});

it("no longer routes retired destinations", () => {
  const hrefs = flattenNavItems().map((i) => i.href);
  for (const legacy of ["/scheduled", "/jobs", "/channels/groups", "/access"]) {
    expect(hrefs).not.toContain(legacy);
  }
});
```

Giữ nguyên các test `isNavItemActive`, `toSearchKey`; bỏ test về `isExact` của `/channels` (không còn mục con nên bỏ luôn `isExact` ở data).

- [ ] **Step 2: Chạy test xác nhận fail**

Run: `pnpm test -- src/ui/components/shell/nav-items.test.ts`
Expected: FAIL (cấu trúc cũ 6 nhóm/13 mục).

- [ ] **Step 3: Sửa `NAV_SECTIONS`**

```ts
export const NAV_SECTIONS: readonly NavSection[] = [
  { title: "Bàn làm việc", items: [{ href: "/", label: "Tổng quan" }] },
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
    items: [{ href: "/platform", label: "Công ty khách" }],
  },
] as const;
```

Cập nhật comment của `NavItem.isExact` (giờ không còn ai dùng nhưng giữ cơ chế) và comment section "Tổ chức" cũ. Trong `AppSideNav.tsx`, chỗ map `/batches` → mục sáng: đổi `"/jobs"` thành `"/posts"` (giữ nguyên cơ chế).

- [ ] **Step 4: Chạy lại test**

Run: `pnpm test -- src/ui/components/shell/nav-items.test.ts src/ui/components/shell/nav-collapse.test.ts`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/shell/
git commit -m "feat(shell): wave-1 nav model - 5 groups, 10 destinations"
```

---

### Task 3: Route `/posts` + redirect `/scheduled`, `/jobs` + breadcrumb `/batches`

**Files:**
- Create: `src/ui/components/posts/legacy-routes.ts` + `src/ui/components/posts/legacy-routes.test.ts`
- Create: `src/ui/components/posts/PostsHub.tsx`
- Create: `src/app/(app)/posts/page.tsx`
- Modify: `src/app/(app)/scheduled/page.tsx`, `src/app/(app)/jobs/page.tsx` (thành redirect thuần)
- Modify: `src/ui/components/batch/BatchStatusScreen.tsx` (breadcrumb đầu màn về `/posts?tab=log`)

**Interfaces:**
- Consumes: `ScheduledScreen` (`src/ui/components/scheduled/ScheduledScreen.tsx`), `JobLogScreen` (`src/ui/components/jobs/JobLogScreen.tsx`) — dùng nguyên trạng, không sửa 2 file này trong task này.
- Produces: `legacyRedirectTarget(pathname: string, search: string): string | null` — Task 4/5 dùng lại cho 2 cặp redirect còn lại; `PostsHub({ tab }: { tab: "scheduled" | "log" })`.

- [ ] **Step 1: Viết test cho helper redirect**

```ts
// legacy-routes.test.ts
import { describe, expect, it } from "vitest";
import { legacyRedirectTarget } from "./legacy-routes";

describe("legacyRedirectTarget", () => {
  it("maps the four retired routes and keeps the query string", () => {
    expect(legacyRedirectTarget("/scheduled", "channel=c1&view=calendar"))
      .toBe("/posts?tab=scheduled&channel=c1&view=calendar");
    expect(legacyRedirectTarget("/jobs", "status=failed"))
      .toBe("/posts?tab=log&status=failed");
    expect(legacyRedirectTarget("/channels/groups", "")).toBe("/channels?tab=groups");
    expect(legacyRedirectTarget("/access", "status=approved"))
      .toBe("/members?tab=history&status=approved");
  });
  it("returns null for live routes", () => {
    expect(legacyRedirectTarget("/posts", "")).toBeNull();
    expect(legacyRedirectTarget("/jobsomething", "")).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy test fail** — `pnpm test -- src/ui/components/posts/legacy-routes.test.ts` → FAIL (module chưa tồn tại).

- [ ] **Step 3: Implement helper**

```ts
// legacy-routes.ts — pure, node-testable, no React.
const LEGACY: Record<string, { base: string; tab: string }> = {
  "/scheduled": { base: "/posts", tab: "scheduled" },
  "/jobs": { base: "/posts", tab: "log" },
  "/channels/groups": { base: "/channels", tab: "groups" },
  "/access": { base: "/members", tab: "history" },
};

/** Old bookmarks keep working: same query, new home. Null = not a legacy path. */
export function legacyRedirectTarget(pathname: string, search: string): string | null {
  const hit = LEGACY[pathname];
  if (!hit) return null;
  const rest = search.replace(/^\?/, "");
  return `${hit.base}?tab=${hit.tab}${rest ? `&${rest}` : ""}`;
}
```

- [ ] **Step 4: Chạy test pass** — `pnpm test -- src/ui/components/posts/legacy-routes.test.ts` → PASS.

- [ ] **Step 5: `PostsHub` + page `/posts`**

`PostsHub.tsx` (client): thanh tab đầu màn (Astryx `SegmentedControl` — chạy `pnpm exec astryx component SegmentedControl` để lấy props đúng) với 2 tab "Bài đã hẹn" / "Nhật ký đăng"; tab ghi vào URL `?tab=` qua `useRouter().replace` + đọc `useSearchParams`; thân render `<ScheduledScreen />` hoặc `<JobLogScreen />` nguyên trạng. Header màn: `h1` "Bài đăng" + mô tả 1 câu (gộp từ 2 màn cũ, KHÔNG bê nguyên đoạn mô tả dài của Scheduled — phần quy tắc chi tiết đã nằm trong màn con).

`src/app/(app)/posts/page.tsx`: sao cấu trúc guard của `jobs/page.tsx` hiện tại (getOperatorSession, `dynamic = "force-dynamic"`, metadata "Bài đăng — MYSP", Suspense fallback dùng `JobLogSkeleton`), render `<PostsHub tab={tab} />` với `tab` đọc từ `searchParams` (mặc định `"scheduled"`, giá trị lạ → `"scheduled"`).

- [ ] **Step 6: Redirect 2 page cũ** — thay toàn bộ thân `scheduled/page.tsx` và `jobs/page.tsx`:

```tsx
// src/app/(app)/scheduled/page.tsx
import { redirect } from "next/navigation";
import { legacyRedirectTarget } from "@/ui/components/posts/legacy-routes";

export const dynamic = "force-dynamic";

export default async function ScheduledRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") params.set(k, v);
  }
  redirect(legacyRedirectTarget("/scheduled", params.toString()) ?? "/posts");
}
```

(`jobs/page.tsx` tương tự với `"/jobs"`.)

- [ ] **Step 7: Breadcrumb `BatchStatusScreen`** — thêm ngay trên `h1`: link "← Bài đăng" (`next/link` tới `/posts?tab=log`), style `text-muted-foreground text-sm`; giữ nguyên các nút cuối màn.

- [ ] **Step 8: Verify + commit**

```bash
pnpm typecheck && pnpm test
git add src/ui/components/posts src/app/\(app\)/posts src/app/\(app\)/scheduled/page.tsx src/app/\(app\)/jobs/page.tsx src/ui/components/batch/BatchStatusScreen.tsx
git commit -m "feat(ia): /posts hub with scheduled+log tabs, legacy redirects"
```

Kiểm tay trên `pnpm dev`: mở `/scheduled?view=calendar` → về `/posts?tab=scheduled&view=calendar`, dialog đổi giờ qua URL vẫn hoạt động; `/jobs?status=failed` → tab Nhật ký đã lọc.

---

### Task 4: `/channels` gộp tab + tên Page trong nhóm kênh

**Files:**
- Create: `src/ui/components/channels/ChannelsHub.tsx`
- Modify: `src/ui/components/channels/ConnectedChannelsScreen.tsx` (tách phần connect panel để render theo tab)
- Modify: `src/ui/components/channels/ChannelGroupsScreen.tsx` (card nhóm hiện tên Page; bỏ khung `max-w-5xl` riêng để sống trong hub)
- Modify: `src/app/(app)/channels/page.tsx` (render hub theo `?tab=`)
- Modify: `src/app/(app)/channels/groups/page.tsx` (redirect thuần, dùng `legacyRedirectTarget("/channels/groups", …)`)

**Interfaces:**
- Consumes: `legacyRedirectTarget` (Task 3); `useChannels` + `useChannelGroups` (hooks sẵn có, không sửa).
- Produces: `ChannelsHub({ tab }: { tab: "pages" | "groups" | "connect" })`.

- [ ] **Step 1: `ChannelsHub`** — 3 tab "Page đã kết nối" / "Nhóm kênh" / "Kết nối thêm" (URL `?tab=`, mặc định `pages`). Tab `pages`: banner OAuth + banner secrets + bảng `ChannelTable` (phần này trích từ `ConnectedChannelsScreen`). Tab `connect`: `ChannelConnectPanel`. Tab `groups`: `ChannelGroupsScreen`. Banner kết quả OAuth (`?connected=…`) đọc ở hub để không mất khi đổi tab.
- [ ] **Step 2: Tên Page trong card nhóm** — trong `ChannelGroupsScreen`, thay danh sách `channelId` mono bằng tên Page: map `group.channelIds` qua data `useChannels()`; id không còn trong danh sách kênh → hiện `id` mono kèm chú thích "(đã gỡ)". Không đổi payload API.
- [ ] **Step 3: Redirect `channels/groups/page.tsx`** theo đúng mẫu Step 6 Task 3.
- [ ] **Step 4: Empty state chéo tab** — tab `pages` khi chưa có Page nào: nút dẫn sang tab `connect` (thay vì focus ô token như cũ).
- [ ] **Step 5: Verify + commit**

```bash
pnpm typecheck && pnpm test
git add src/ui/components/channels src/app/\(app\)/channels
git commit -m "feat(ia): channels hub - pages/groups/connect tabs, page names in groups"
```

Kiểm tay: `/channels/groups` → `/channels?tab=groups`; luồng OAuth callback (`?connected=2`) vẫn hiện banner; tạo/sửa/xoá nhóm hoạt động trong tab.

---

### Task 5: `/members` gộp tab (Thành viên / Link mời / Lịch sử duyệt)

**Files:**
- Create: `src/ui/components/members/MembersHub.tsx`
- Modify: `src/ui/components/members/MembersScreen.tsx` (nhận prop `showInvites?: boolean` — mặc định true để không phá chỗ khác; hub gọi `false`)
- Modify: `src/app/(app)/members/page.tsx` (render hub theo `?tab=`)
- Modify: `src/app/(app)/access/page.tsx` (redirect thuần)

**Interfaces:**
- Consumes: `legacyRedirectTarget` (Task 3); `MembersScreen`, `InvitePanel`, `AccessRequestsScreen` nguyên trạng (trừ prop mới của MembersScreen).
- Produces: `MembersHub({ tab }: { tab: "members" | "invites" | "history" })`.

- [ ] **Step 1: `MembersHub`** — 3 tab; `members` → `<MembersScreen showInvites={false} />`; `invites` → `InvitePanel` đứng riêng (giữ nguyên logic URL-một-lần của link mời); `history` → `AccessRequestsScreen` nguyên trạng (kèm guard `canManageAccess` và `AccessForbidden` như route cũ — guard đi theo component, không mất khi đổi nhà).
- [ ] **Step 2: Prop `showInvites`** trong `MembersScreen`: bọc render `InvitePanel` hiện tại trong điều kiện; không đổi gì khác.
- [ ] **Step 3: Redirect `access/page.tsx`** theo mẫu Task 3, giữ `?status=`.
- [ ] **Step 4: Banner trong `AccessRequestsScreen`** đổi lời: "Luồng duyệt đã nghỉ hưu" giữ nguyên nhưng nút "Mở màn Thành viên" đổi thành chuyển tab `?tab=members` (cùng route, không load lại).
- [ ] **Step 5: Verify + commit**

```bash
pnpm typecheck && pnpm test
git add src/ui/components/members src/ui/components/access src/app/\(app\)/members src/app/\(app\)/access
git commit -m "feat(ia): members hub - members/invites/history tabs"
```

Kiểm tay: `/access?status=approved` → `/members?tab=history&status=approved`; filter lịch sử vẫn chạy; tạo link mời trong tab `invites` vẫn hiện URL một lần.

---

### Task 6: Shell — chỉ báo "ngoài công ty" ở `/platform`

**Files:**
- Modify: `src/ui/components/shell/AppTopBar.tsx` hoặc `AppFrame.tsx` (chọn chỗ đã render `TenantSwitcher`)

**Interfaces:**
- Consumes: `usePathname()` của Next.

- [ ] **Step 1:** Khi `pathname.startsWith("/platform")`: cạnh `TenantSwitcher` render badge tĩnh (Astryx `Token` hoặc `Badge` — tra `pnpm exec astryx component Token`) chữ "Ngoài công ty — màn quản trị MYSP", tone info. Không ẩn switcher (đổi công ty từ đây vẫn hợp lệ).
- [ ] **Step 2:** `pnpm typecheck && pnpm test`, kiểm tay `/platform` thấy badge, các màn khác không.
- [ ] **Step 3: Commit** — `git add src/ui/components/shell && git commit -m "feat(shell): out-of-tenant indicator on /platform"`.

---

### Task 7: Màn Tổng quan mới

**Files:**
- Create: `src/ui/components/overview/OverviewScreen.tsx`
- Create: `src/ui/components/overview/overview-model.ts` + `overview-model.test.ts` (logic thuần: chọn "việc cần chú ý" từ 2 nguồn)
- Modify: `src/app/(app)/page.tsx` (render OverviewScreen; giữ guard + cảnh báo isDevFake)

**Interfaces:**
- Consumes: `useScheduledJobs(filter)` (`src/ui/hooks/useScheduledJobs.ts`), `usePostJobLog(filter: JobLogFilter)` (`src/ui/hooks/usePostJobs.ts`), `TenantHealthPanel` (giữ, sau disclosure).
- Produces: `pickAttentionItems(input: { failedJobs: readonly T[]; upcoming: readonly U[] }): AttentionItem[]` trong `overview-model.ts`.

- [ ] **Step 1: TDD `overview-model.ts`** — test trước:

```ts
it("puts failed jobs before upcoming, caps the list at 6", () => {
  const items = pickAttentionItems({
    failedJobs: [f1, f2],           // object tối thiểu: { id, code, channelName, reason }
    upcoming: [u1, u2, u3, u4, u5], // { id, code, channelName, scheduledAt }
  });
  expect(items.slice(0, 2).every((i) => i.kind === "failed")).toBe(true);
  expect(items).toHaveLength(6);
});
it("returns [] when both sources are empty", () => {
  expect(pickAttentionItems({ failedJobs: [], upcoming: [] })).toEqual([]);
});
```

Chạy fail → implement (pure function, kiểu dữ liệu lấy từ `post-batch.schema` / `scheduled.schema` sẵn có) → chạy pass.

- [ ] **Step 2: `OverviewScreen`** — bố cục theo FIRST VIEWPORT của contract:
  1. Hàng liên kết số liệu trên "nhãn dệt" (mono label uppercase + số tabular khi có): **Đang chờ giờ** (đếm từ trang đầu `useScheduledJobs` — nếu response không có tổng thì hiện "N+" theo số dòng đã tải, không bịa tổng) → link `/posts?tab=scheduled`; **Lỗi cần xử lý** (từ `usePostJobLog({ status: "failed", … })` trang đầu, cùng quy tắc đếm) → `/posts?tab=log&status=failed`; **Bài lên hôm nay** → `/posts?tab=log` (chỉ liên kết, KHÔNG số — chưa có nguồn đếm sẵn); **Mã bị chặn** → `/products?loc=blocked` (chỉ liên kết). Không tạo endpoint mới.
  2. Khối "Việc cần chú ý" từ `pickAttentionItems`: dòng failed → link `/posts?tab=log&status=failed`; dòng sắp tới giờ → `/posts?tab=scheduled`. Empty → 1 câu "Không có gì cần chú ý — mọi bài đang đúng lịch."
  3. Hành động chính duy nhất: nút primary "Soạn bài mới" → `/compose`.
  4. Cuối trang: disclosure "Sức khoẻ hệ thống" chứa `TenantHealthPanel` nguyên trạng (mặc định gập).
  States: loading dùng skeleton + `useDelayedFlag` 300ms như chuẩn repo; lỗi từng nguồn hiện `ApiErrorNotice` cục bộ, nguồn kia vẫn sống.
- [ ] **Step 3:** `page.tsx` render `<OverviewScreen />`, giữ cảnh báo `isDevFake` hiện có.
- [ ] **Step 4:** `pnpm typecheck && pnpm test`; kiểm tay: các ô link đi đúng đích + filter.
- [ ] **Step 5: Commit** — `git add src/ui/components/overview src/app/\(app\)/page.tsx && git commit -m "feat(overview): real overview - stat links, attention list, single CTA"`.

---

### Task 8: Compose — bố cục mới (không đụng hook)

**Files:**
- Modify: `src/ui/components/compose/ComposeFocus.tsx` (bỏ SchedulePicker giữa card; rail bước; sticky bar)
- Modify: `src/ui/components/compose/ComposeActionBar.tsx` (sticky, chứa vùng hẹn giờ)
- Modify: `src/ui/components/compose/ChannelPickerDialog.tsx` + `channel-picker.ts` + `channel-picker.test.ts` (thêm chọn theo nhóm)
- Delete: `src/ui/components/compose/compose-theme.ts` (+ mọi tham chiếu `--compose-*`, `COMPOSE_PALETTE`)

**Interfaces:**
- Consumes: `useChannelGroups()` (hook sẵn có); `usePublishForm`/`useScheduleChoice` nguyên trạng — bar chỉ đổi chỗ render, props giữ nguyên tên.
- Produces: `applyChannelGroup(current: readonly string[], groupChannelIds: readonly string[], activeChannelIds: readonly string[]): string[]` trong `channel-picker.ts`.

- [ ] **Step 1: TDD `applyChannelGroup`** — test trong `channel-picker.test.ts`:

```ts
it("unions the group into the selection, keeping only active channels", () => {
  expect(applyChannelGroup(["a"], ["b", "dead"], ["a", "b", "c"])).toEqual(["a", "b"]);
});
it("is idempotent", () => {
  expect(applyChannelGroup(["a", "b"], ["b"], ["a", "b"])).toEqual(["a", "b"]);
});
```

Chạy fail → implement (union giữ thứ tự, lọc theo active) → pass.

- [ ] **Step 2: Nhóm kênh trong `ChannelPickerDialog`** — trên danh sách kênh: hàng chip nhóm (từ `useChannelGroups`), bấm chip gọi `applyChannelGroup`; nhóm rỗng/lỗi thì ẩn hàng, không chặn dialog. Selection vẫn chỉ apply khi bấm "Xong" (giữ hành vi cũ).
- [ ] **Step 3: Sticky action bar** — `ComposeActionBar` bọc trong container `sticky bottom-0` nền `bg-background/95 backdrop-blur` + border-t hairline, nằm cuối cột trái; vùng hẹn giờ: khi toggle "Hẹn lịch" bật, `SchedulePicker` render NGAY TRÊN bar (cùng container sticky) — xoá chỗ render `SchedulePicker` giữa card trong `ComposeFocus`. Props/hook không đổi.
- [ ] **Step 4: Rail bước** — cột trái đánh số 4 mốc bằng eyebrow mono ("BƯỚC 1 — SẢN PHẨM", "BƯỚC 2 — ẢNH & MÀU", "BƯỚC 3 — KÊNH & LỊCH", "BƯỚC 4 — CAPTION") trên từng section sẵn có; số nằm trong rail lề trái cố định (grid 2 cột: rail 2.5rem + nội dung), mọi bước cuộn lại được. Không đổi thứ tự khối, chỉ thêm mốc.
- [ ] **Step 5: Xoá `compose-theme.ts`** — thay mọi `var(--compose-*)` bằng token semantic tương đương (`--compose-ink` → `text-foreground`/`bg-foreground`, `--compose-hairline` → `border`, `--compose-radius-control` → `rounded-lg`); xoá import trong `ComposeFocus`, `ChannelChoice`, `ChannelPickerDialog`, `ComposeActionBar`, `channel-picker.ts`, `color-swatch.ts`, `compose/page.tsx`. Chạy `grep -rn "compose-theme\|--compose-" src/` phải về 0 kết quả.
- [ ] **Step 6: Verify + commit**

```bash
pnpm typecheck && pnpm test && grep -rn "compose-theme\|--compose-" src | wc -l
git add src/ui/components/compose src/app/\(app\)/compose
git commit -m "feat(compose): sticky action bar, single schedule entry, channel groups in picker, drop bespoke palette"
```

Kiểm tay đủ luồng: soạn ảnh 2 kênh → đăng luôn; bật hẹn lịch từ bar → hẹn giờ; chọn nhóm kênh trong dialog; read-only support mode vẫn disable kèm lý do.

---

### Task 9: Inspect round + finish + gate + PR

**Files:** không tạo code mới ngoài sửa lỗi từ findings.

- [ ] **Step 1: Verify đầy đủ** — `pnpm verify` (typecheck + lint + depcruise + test + build). Mọi lỗi sửa trước khi đi tiếp; dán output thật vào báo cáo.
- [ ] **Step 1b: Vá 2 finding P1 từ critique 21/08 (PM đã duyệt nhập wave 1)** — (a) `JobLogTable` cột "Kênh": hiện tên Page thay `channelId` thô (map qua data `useChannels`, id xuống dòng mono phụ/tooltip; kênh đã gỡ → id + "(đã gỡ)"); (b) `CaptionBlock` tablist: thêm arrow-key navigation đúng pattern ARIA tabs (Left/Right/Home/End, roving tabindex). Kèm theo carry-forward Task 1: IMP-1 `--foreground-subtle` light → L≈0.53; IMP-2 tách dark `--info` khỏi dark `--primary` + sửa claim comment globals.css:140; IMP-3 pin dark `--foreground-subtle`; MIN-1 thêm English gloss 2 comment tiếng Việt trần.
- [ ] **Step 2: Inspect round có giới hạn (doc 12 §6)** — `pnpm dev`, chụp desktop + mobile các màn đợt 1 (`/`, `/compose`, `/posts` 2 tab, `/channels` 3 tab, `/members` 3 tab, `/platform` badge) vào `.impeccable/review/desktop.png`, `mobile.png`; sửa 1 đợt; tối đa 1 vòng xác nhận.
- [ ] **Step 3: Detector** — `node ~/.claude/skills/impeccable/scripts/detect.mjs --json` trên các file đã đổi; sửa lỗi cơ học, findings còn lại chuyển cho reviewer.
- [ ] **Step 4: Impeccable finish** — spawn `impeccable-finish-reviewer` (input: request gốc, spec, contract, screenshots, findings, craft-floor); xử lý disposition đúng 4 từ (recapture/rebuild/ship/fix). Sau đó spawn `impeccable-documenter` ghi lại `DESIGN.md` + sidecar từ code mới.
- [ ] **Step 5: Gate `reviewer-qa`** — review toàn diff đợt 1 + output verify; FAIL → `ui-web` sửa → gate lại tới PASS.
- [ ] **Step 6: PR** — push branch, tạo PR vào `dev` theo flow repo (agent review + comment + undraft — memory `pr-review-agent-flow`); PM merge. Sau merge: cập nhật `docs/08-tien-do-du-an.md` và 2 artifact roadmap (memory `update-roadmap-artifact-per-sprint`).

---

## Self-Review (đã chạy)

- **Spec coverage:** §2 contract → Task 1 (token + comment) và Task 8/7 (raise áp vào bố cục); §3.1 nav+redirect → Task 2–5; chỉ báo platform → Task 6; §3.2 → Task 7; §3.3 → Task 8; §3.4 tên Page → Task 4, drawer `/products` + tách hành động `/platform` + khung Astryx thống nhất toàn màn = **đợt 2** (spec §1 xếp các màn đó vào đợt 2 — không thiếu).
- **Placeholder:** không còn TBD/TODO; các bước UI mô tả bằng hành vi + component Astryx cần tra (`astryx component …`) — executor bắt buộc tra trước khi viết, đúng workflow Astryx của repo.
- **Type consistency:** `legacyRedirectTarget(pathname, search)` dùng thống nhất Task 3/4/5; `PostsHub/ChannelsHub/MembersHub` cùng khuôn `{ tab }`; `applyChannelGroup` khớp test và call-site.
