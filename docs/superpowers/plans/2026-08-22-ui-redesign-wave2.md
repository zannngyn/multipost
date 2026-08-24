# UI Redesign "Sổ mẫu vải" — Wave 2 Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Flow repo:** orchestrator giao task cho `ui-web`; gate `reviewer-qa` PASS sau mỗi task; fix loop như wave 1.

**Goal:** Hoàn chỉnh thế giới "Sổ mẫu vải" trên toàn app: tên Page thay raw ID (P0), 5 màn còn lại vào hệ, lỗ rule-5 `skipped=Y` đóng, giảm tải chữ, thống nhất từ vựng, dọn kỹ thuật.

**Architecture:** Thuần tầng trình bày, MỞ THÊM `src/ui/schemas/**` (chỉ `channel.schema.ts` + test) và `next.config.ts` (redirects). Tái dùng hạ tầng wave 1: `channel-group-labels.ts` (tên Page), `navigation/tab-param.ts`, token DESIGN.md, pattern hub/TabList, statValue/gating-hint.

**Tech Stack:** Next.js 16, Astryx v0.4.0 (theme `mysp`), Tailwind v4 token, vitest node env.

**Spec:** `docs/superpowers/specs/2026-08-22-ui-redesign-wave2-design.md` (PM duyệt 22/08 — bản PM đã sửa §1).

## Global Constraints

- CẤM sửa: `src/ui/hooks/**`, `src/ui/services/**`, `src/app/api/**`, `src/core/**`, `src/adapters/**`, `src/worker/**`. `src/ui/schemas/**` CHỈ được sửa trong Task 2 (`channel.schema.ts` + test của nó). `next.config.ts` CHỈ trong Task 10.
- DESIGN.md "Sổ mẫu vải" là luật: token semantic, ramp (gồm 15/13/11/10px), Named Rules (One Indigo, Named Status, Mono Ledger, Woven Label, Ink Hairline, Flat-By-Default), 4 raise của direction contract.
- Mỗi giá trị hiển thị kênh: TÊN Page trước, id mono phụ; không raw id đứng một mình.
- Copy: intro ≤2 câu, chi tiết vào disclosure; UI tiếng Việt, code/comment/commit tiếng Anh.
- States chuẩn repo giữ nguyên hành vi (loading 300ms, empty 2 nghĩa, error 4xx/5xx, stale, read-only).
- Verify tối thiểu mỗi task: `pnpm exec vitest run <thư mục liên quan>` + `pnpm typecheck && pnpm lint`; task cuối `pnpm verify` đầy đủ + kiểm artifact.
- Branch: `redesign/swatch-book-w2` từ dev mới nhất (tạo ở Task 1). Commit theo task, không push/PR tới Task 11.
- Preview: worktree tạm + `DEV_FAKE_SESSION=1 next dev -p <port riêng>` (KHÔNG chạy được với next start; KHÔNG đụng :3000).
- Quyết định treo C/D/E: không tự quyết, giữ `// PENDING(<mã>)`.

---

### Task 1: Nhánh + tên Page thay raw ID toàn app [P0, spec §3.1]

**Files:**
- Create: `src/ui/components/channels/channel-option-labels.ts` + `.test.ts` (nếu cần helper mới cho Select/checkbox; ưu tiên tái dùng `channel-group-labels.ts`)
- Modify: `src/ui/components/scheduled/ScheduledScreen.tsx` (Select "Lọc theo kênh"), `src/ui/components/scheduled/ScheduledJobTable.tsx` (cột kênh), `src/ui/components/bulk/BulkRunScreen.tsx` + `src/ui/components/compose/ChannelGroupPicker.tsx` (checkbox nhóm — khử page trùng giữa nhóm)
- Grep sweep: `grep -rn "channelId" src/ui/components --include="*.tsx"` — mọi chỗ render id trần còn lại

**Interfaces:**
- Consumes: `resolveGroupChannelLabels(channelIds, channels)` (wave 1, `channels/channel-group-labels.ts`), `useChannels()` data đã có ở caller hoặc truyền prop như JobLogTable đã làm.
- Produces: pure helper `dedupeChannelsAcrossGroups(groups, channels)` cho /bulk (một page hiện MỘT lần, ghi chú "thuộc N nhóm").

- [ ] **Step 1: TDD `dedupeChannelsAcrossGroups`** — test: page nằm trong 2 nhóm chỉ ra 1 dòng, giữ thứ tự nhóm đầu tiên, kênh inactive bị loại như logic cũ; chạy đỏ → implement → xanh.
- [ ] **Step 2:** ScheduledScreen Select filter: option label = tên Page (id vào phần phụ nếu component cho phép); ScheduledJobTable cột kênh theo đúng pattern JobLogTable wave 1 (tên + id mono phụ, "(đã gỡ)" khi không còn).
- [ ] **Step 3:** BulkRunScreen/ChannelGroupPicker: danh sách phẳng dùng helper dedupe + tên Page; id chỉ tooltip/mono phụ.
- [ ] **Step 4:** Grep sweep phần còn lại — sửa hết chỗ id trần; ghi danh sách chỗ đã sửa vào report.
- [ ] **Step 5:** `pnpm exec vitest run src/ui/components/scheduled src/ui/components/bulk src/ui/components/compose src/ui/components/channels && pnpm typecheck && pnpm lint` → commit `feat(ui): page names everywhere, dedupe bulk channel list`.

### Task 2: `skipped=Y` hiển thị [rule 5, spec §3.3] — task DUY NHẤT được sửa schemas

**Files:**
- Modify: `src/ui/schemas/channel.schema.ts` (`parseConnectOutcome` đọc thêm `new`, `skipped`) + `src/ui/schemas/channel.schema.test.ts`
- Modify: `src/ui/components/channels/ChannelsHub.tsx` (banner kết quả OAuth), `src/ui/components/channels/channels-tabs.test.ts` (CALLBACK_QUERIES giữ nguyên — wipe list đã đủ 5 param từ wave 1)

**Interfaces:**
- Produces: `ConnectOutcome` mở rộng `{connected, newCount, skipped}` (đặt tên tránh trùng từ khoá `new`).

- [ ] **Step 1: TDD schema** — test đỏ: `parseConnectOutcome("connected=2&new=1&skipped=3")` trả `{connected:2, newCount:1, skipped:3}`; thiếu param → 0/null có chủ đích; giá trị rác → null như hành vi cũ; MỌI test cũ giữ nguyên pass.
- [ ] **Step 2:** Banner ChannelsHub: "Đã nhập N Page (X mới). Y Page bị bỏ qua — thường do thiếu quyền hoặc đã thuộc công ty khác; kiểm tra danh sách Page trong tài khoản Facebook." (Y=0 thì không nói tới). Tone: success khi skipped=0, warning khi skipped>0 (Named Status — có chữ, không chỉ màu).
- [ ] **Step 3:** `pnpm exec vitest run src/ui/schemas src/ui/components/channels && pnpm typecheck` → commit. Gate soát riêng mục schema theo Global Constraints.

### Task 3: `/posts` ruột bảng + giảm chữ [spec §3.2, §3.4]

**Files:**
- Modify: `src/ui/components/scheduled/{ScheduledScreen,ScheduledJobTable}.tsx`, `src/ui/components/jobs/{JobLogScreen,JobLogTable}.tsx`, `src/ui/components/posts/PostsHub.tsx`
- Create: helper thuần gom dòng trùng mã (`posts/job-row-grouping.ts` + test) nếu gom ở tầng render

- [ ] **Step 1:** Intro /posts: còn ≤2 câu; phần quy tắc (múi giờ, "Facebook giữ lịch", đổi giờ) vào disclosure "Chi tiết quy tắc" ngay dưới intro. Tab label "Nhật ký đăng" và heading thống nhất một chữ.
- [ ] **Step 2:** Cột Màu → chip vải (tái dùng pattern swatch ColorChips — chấm màu + CHỮ tên màu); trạng thái → token madder/turmeric/leaf + chữ (map caller như PostStatusBadge hiện có, kiểm tint 10% phân biệt được).
- [ ] **Step 3: TDD gom dòng** — job cùng mã cùng lỗi ở nhiều kênh gộp "MGKVX6310 × 5 kênh", mở rộng được (disclosure per-row); job khác lỗi không gộp.
- [ ] **Step 4:** Mobile: container bảng thêm cue cuộn ngang (gradient mép phải khi còn nội dung — CSS thuần, không JS scroll-listener) HOẶC xếp chồng ở bậc hẹp — chọn theo cái đọc tốt hơn khi preview, ghi lý do.
- [ ] **Step 5:** Verify thư mục + typecheck + lint → commit.

### Task 4: `/products` [spec §3.2]

**Files:** `src/ui/components/products/{ProductListScreen,ProductInspector}.tsx` (+ component drawer nếu Astryx có — tra `astryx search "drawer"` trước)

- [ ] **Step 1:** Dưới 1024px inspector thành drawer (component Astryx nếu có; không có thì Dialog full-height — KHÔNG tự chế div overlay): chọn dòng mở drawer, "Soạn bài" luôn với tới được.
- [ ] **Step 2:** Chấm đỏ/vàng có chú giải chữ (legend một dòng trên bảng hoặc tooltip + sr-only text — màu không đứng một mình).
- [ ] **Step 3:** Cụm filter mobile: search full-width một hàng, SegmentedControl hàng dưới; hết wrap 3 tầng.
- [ ] **Step 4:** Verify + commit.

### Task 5: `/sync` [spec §3.2]

**Files:** `src/ui/components/sync/{SyncRunRail,GoogleConnectionPanel,SyncScreen}.tsx`

- [ ] **Step 1:** Run-list rail: phân cấp bằng CON SỐ (số vấn đề nổi bật mono, ngày mờ hơn) — không thêm màu mới; 5 dòng giống nhau phải phân biệt được bằng liếc.
- [ ] **Step 2:** GoogleConnectionPanel `border-l-4` → callout chuẩn hệ (nền tint 10% + hairline, không side-tab dày).
- [ ] **Step 3:** Panel chính: đầu mục "bước 03" không bị cắt ở fold 900px (điều chỉnh sticky/padding).
- [ ] **Step 4:** Verify + commit.

### Task 6: `/bulk` [spec §3.2, §3.4]

**Files:** `src/ui/components/bulk/{BulkRunScreen,BulkCodesField,BulkProgressTable}.tsx`

- [ ] **Step 1:** Khung theo hệ (nền vải mộc + panel card, header chuẩn, "Tải lại" nếu có ở góc phải); intro ≤2 câu + disclosure; slug kỹ thuật sạch (đã có tên Page từ Task 1).
- [ ] **Step 2:** Copy ranh giới tab: một câu rõ "Đóng tab: các lô ĐÃ tạo vẫn đăng tiếp trên máy chủ; các mã CHƯA tạo lô sẽ dừng" đặt cạnh nút Chạy (thay câu dặn chung chung).
- [ ] **Step 3:** BulkProgressTable: trạng thái token + chữ theo Named Status; mã mono nowrap.
- [ ] **Step 4:** Verify + commit.

### Task 7: `/prompts` [spec §3.2]

**Files:** `src/ui/components/prompts/{PromptTemplatesScreen,PromptVersionTable,PromptVersionForm}.tsx`

- [ ] **Step 1:** Khung theo hệ; form tạo phiên bản mở NGAY DƯỚI nút (inline panel), không ở cuối trang; focus vào field đầu khi mở.
- [ ] **Step 2:** Sửa nhãn phiên bản: hai bản không được cùng ghi "v2" — hiển thị số version thật + thời điểm, bản "Đã thay thế" ghi rõ "thay bởi vN lúc …" nếu dữ liệu có; dữ liệu không đủ thì hiển thị timestamp để phân biệt (không bịa).
- [ ] **Step 3:** Verify + commit.

### Task 8: `/platform` + nền đồng nhất hub [spec §3.2]

**Files:** `src/ui/components/platform/{PlatformScreen,PlatformTenantTable}.tsx`; `src/ui/components/{channels/ChannelsHub,members/MembersHub,posts/PostsHub}.tsx` + screen con nếu nền lệch

- [ ] **Step 1:** PlatformTenantTable: "Khoá/Mở khoá" ra khỏi hàng nút ngang — vào menu "⋯" (Astryx Menu/Dropdown — tra component) với item destructive riêng; "Vào hỗ trợ" giữ là nút thường. Confirm + lý do giữ nguyên logic.
- [ ] **Step 2:** Sweep nền: mọi màn đứng trên `--background` vải mộc, panel nội dung `--card` + hairline; hết vùng trắng `#fff` lib mặc định (kiểm bằng screenshot so màu, không tin mắt).
- [ ] **Step 3:** Verify + commit.

### Task 9: Từ vựng + song ngữ + signin [spec §3.5, §3.7]

**Files:** grep-driven: mọi file components có "Fanpage"/"Page"/"Kênh" lệch chuẩn; `src/ui/components/auth/SignInScreen.tsx`

- [ ] **Step 1:** Quét từ vựng về chuẩn spec (khái niệm = "Kênh"; đích danh Facebook = "Page"); bảng thay đổi ghi vào report (chuỗi cũ → mới, file:line).
- [ ] **Step 2:** Quét chuỗi tiếng Anh user-facing còn sót (ngoài các mục wave 1.5) — sửa hoặc ghi "giới hạn lib".
- [ ] **Step 3:** SignInScreen: "MysP"→"MYSP" (2 chỗ), "All right reserved"→"All rights reserved", bỏ form email disabled + "Quên mật khẩu" của tính năng chưa có (giữ 2 nút thật). Không redesign.
- [ ] **Step 4:** Verify + commit.

### Task 10: Dọn kỹ thuật [spec §3.6]

**Files:** `src/ui/components/access/AccessRequestsScreen.tsx`, `src/ui/components/members/members-tabs.test.ts`, `src/ui/components/posts/legacy-routes.ts`, `.impeccable/config.json`, `src/ui/theme/` (+ test mới), `next.config.ts`

- [ ] **Step 1:** `access/` + `members-tabs.test.ts` import `POSTS_TAB_PARAM`/`withTabParam` từ `@/ui/components/navigation/tab-param` (bỏ đường vòng posts-tabs); `legacy-routes.ts` dùng helper thay chuỗi `tab=` tay.
- [ ] **Step 2:** `.impeccable/config.json`: gỡ 3 ignore font-size hết hạn (DESIGN.md đã ghi ramp); thêm `ignoreFiles` cho `src/ui/theme/mysp.css` (file @generated). Chạy detector xác nhận: 0 finding font-size từ ramp hợp thức, 0 finding màu từ file sinh máy.
- [ ] **Step 3:** Test pin `src/ui/theme/mysp-theme.ts` ↔ `mysp.css` đã build: test đọc mysp.css assert 4 dòng `--color-text-*` đúng giá trị nguồn (M-3).
- [ ] **Step 4:** `next.config.ts` thêm `redirects()` 307 thật cho 4 route cũ (giữ query — Next tự giữ); page redirect cũ GIỮ NGUYÊN làm defence-in-depth; kiểm bằng curl worktree: HTTP 307/308 thật ở tầng edge.
- [ ] **Step 5:** Sweep-test nit wave 1 còn lại (fixture route chết trong nav-items.test, ví dụ trung tính). Verify + commit.

### Task 11: Finish wave 2

- [ ] **Step 1:** `pnpm verify` đầy đủ + artifact + grep contract seed còn sống.
- [ ] **Step 2:** Inspect round có giới hạn: worktree + Playwright, desktop 1440 + mobile 390, đủ 15 route, ảnh vào `.impeccable/review/` (ghi đè); MỘT đợt sửa; tối đa 1 vòng xác nhận.
- [ ] **Step 3:** Detector trên target đổi → sửa cơ học, còn lại chuyển reviewer.
- [ ] **Step 4:** Finish-review (degraded inline như wave 1) chấm theo direction contract + spec §1; xử lý disposition 4 từ; documenter cập nhật DESIGN.md nếu hệ nở (chip vải bảng, drawer, menu danger là component mới của hệ).
- [ ] **Step 5:** Gate `reviewer-qa` final toàn nhánh (spec coverage + ranh giới 6 thư mục cấm + schemas chỉ Task 2 + next.config chỉ Task 10).
- [ ] **Step 6:** HỎI PM rồi mới push + PR vào dev (flow agent review + undraft, PM merge). Sau merge: docs/08 + artifact roadmap + chạy lại critique (mục tiêu ≥33/40).

---

## Self-Review (đã chạy)

- **Spec coverage:** §3.1→T1 · §3.2→T3-T8 · §3.3→T2 · §3.4→T3/T6 (chuẩn ≤2 câu ghi ở Global Constraints áp mọi task) · §3.5+§3.7→T9 · §3.6→T10 · §6→T11. Phase B: ngoài plan này (spec con riêng). Không mục nào bỏ sót.
- **Placeholder:** không TBD; các bước UI mô tả hành vi + component Astryx phải tra trước khi viết (workflow chuẩn repo).
- **Type consistency:** helper mới đều pure + test node env; `ConnectOutcome.newCount` tránh từ khoá; dedupe helper chỉ dùng trong T1.
- **Ranh giới:** schemas chỉ T2, next.config chỉ T10 — gate final kiểm được bằng `git log --stat` theo task.
