# Onboarding kiểu Buffer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay wizard thiết lập 6 bước bằng luồng Buffer: đăng ký xong có sẵn tổ chức, đăng
nhập lần đầu thấy màn chào toàn màn hình, rồi 4 bước khảo sát hồ sơ, xong vào thẳng app.

**Architecture:** Giữ route group `(onboarding)` đã dựng. Viết lại máy trạng thái từ 6 slide
thiết lập thành 5 màn khảo sát. Thêm bảng `tenant_profile` để lưu đáp án. Tổ chức được cấp
tự động khi tài khoản chưa có tổ chức lần đầu vào app, dùng lại `createTenant` sẵn có.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript · Drizzle + PostgreSQL ·
TanStack Query · Astryx · Tailwind v4 · framer-motion · Vitest (`environment: "node"`, KHÔNG jsdom)

**Spec:** `docs/superpowers/specs/2026-08-26-onboarding-buffer-clone-design.md`
**Tham chiếu hệ thống:** `docs/superpowers/specs/2026-08-26-buffer-system-analysis.md`

---

## Global Constraints

- **MỞ ẢNH THAM CHIẾU TRƯỚC KHI DỰNG BẤT KỲ MÀN NÀO.** Sáu ảnh chụp từ hệ thống thật ở
  `docs/superpowers/specs/assets/buffer-onboarding/` (spec §0b). Dựng theo số đo mà không
  nhìn ảnh là dựng mù. Bốn ảnh có trạng thái **đang chọn** — thứ dễ làm sai nhất — và một
  ảnh bắt đúng lúc chuyển bước.
- **Chuyển bước là CROSSFADE, không trượt ngang** (spec §2.5, ảnh `05-…`). Bản năng sẽ
  dựng slideshow trượt ngang; đó là sai.
- **Buffer giữ MỘT URL cho cả luồng; MYSP thì KHÔNG** (spec §0c). Cả sáu ảnh tham chiếu đều
  chụp ở `publish.buffer.com/onboarding` — họ giữ vị trí trong state React. MYSP **cố ý**
  đặt bước lên URL (`?step=`) để F5 không mất chỗ, nút Back lùi một bước, và gửi link chỉ
  được đúng bước. Clone phần **nhìn thấy được**, không clone phần điều hướng.
- **Mọi giá trị thị giác lấy từ spec §2**, đo từ Buffer thật. Không ước lượng, không bịa.
  Bảng hex trong spec là để **ánh xạ sang token Astryx**, KHÔNG dán thẳng vào code.
  Thiếu token tương ứng → báo orchestrator, **không tự thêm biến màu**.
- **Skill bắt buộc khi dựng UI:** chạy `/ui-ux-pro-max` trước khi viết component. Kèm nhóm 1
  SKILL-MAP: `core/web-component-reuse`, `-accessibility`, `-feedback-states`, `-design-tokens`;
  theo chủ đề: `core/web-onboarding`, `core/web-wizard`, `core/web-motion`, `core/web-form-architecture`.
- **KHÔNG ĐỤNG `src/ui/components/compose/**` VÀ ROUTE `/compose`.** PM chốt 26/08/2026:
  màn soạn bài giữ nguyên. Thấy mình đang sửa file trong `compose/` là đã đi sai phạm vi.
- **Test không có DOM.** `environment: "node"`, không jsdom, không testing-library. Render
  test dùng `renderToStaticMarkup`. Cấm thêm jsdom.
- **Luật phụ thuộc một chiều** (docs/07): `app/worker/ui → composition → adapters → core`.
  `src/ui` KHÔNG import `src/app`. `core/` không import lib I/O. `depcruise` cưỡng chế.
- **Edge case trước, happy path sau.** Cấm `catch {}` rỗng.
- Chữ hiển thị tiếng Việt; tên biến, comment, commit message tiếng Anh.
- **Lệnh gate:** `pnpm verify` = `typecheck && lint && depcruise && theme:check &&
  theme:presets:check && test && build`.
- **Gate người:** `reviewer-qa` PASS trước khi báo xong.

### Cảnh báo môi trường — đọc trước khi hoảng

1. **HEAD của checkout đang ở nhánh `feat/minio-presigned-upload` của một job khác.**
   `dev` ở `181ce9f`. **KHÔNG `git checkout`/`git switch`** — sẽ giật nhánh khỏi họ.
   Commit lên `dev` bằng plumbing: `git read-tree` từ `dev` → cập nhật index CHỈ với file
   của mình → `git write-tree` → `git commit-tree` → `git update-ref refs/heads/dev`.
   Không push.
2. **Cây làm việc dùng chung.** File của job MinIO (`package.json` có `minio`,
   `src/composition/config*`, `src/adapters/media/minio-*`) nằm lẫn trong đó. **Không
   commit file của họ.** `dev` hiện SẠCH, không có `minio` — giữ nguyên thế.
3. `pnpm typecheck`/`pnpm test` có thể đỏ vì file dở dang của họ. Chạy `git status` xác
   nhận rồi ghi rõ trong báo cáo, đừng nhận là lỗi mình, đừng sửa file của họ.
4. **Dev server của worktree ở cổng 3010** (`DEV_FAKE_SESSION=1`). Cần cookie
   `mysp_active_tenant=00000000-0000-0000-0000-000000000001` mới vào được onboarding, không
   có thì ra màn chọn công ty. Cổng 3000 là cây chính, code khác. Đừng dựng thêm server,
   đừng giết, cấm `pkill`.
5. **BẪY: `pnpm build` ghi đè `.next` của dev server và giết hydration ÂM THẦM.** Sau khi
   build, trang vẫn trả 200 và vẫn trông đúng, nhưng **không bấm được gì** — không lỗi,
   không cảnh báo. Đã làm mất một vòng của Task 5. **Chạy `pnpm build` xong thì phải khởi
   động lại dev server trước khi chụp hoặc kiểm tay.** Thứ tự an toàn: kiểm thị giác trước,
   `build` sau cùng.
6. **Hai agent chạy song song trong cùng worktree thì index là của chung.** Commit phải
   dùng pathspec — `git commit -m "…" -- <đường dẫn cụ thể>` — nếu không việc đang staged
   của agent kia sẽ lọt vào commit của mình. Không `git add -A`, không `git add .`.

### Việc lượt trước — giữ gì bỏ gì

| Thứ | Quyết định |
|---|---|
| `src/app/api/_lib/oauth-return-cookie.ts` + 4 route OAuth | **GIỮ**, nhưng nay là code chết — xem ghi chú dưới |
| `eslint.config.mjs` bỏ qua `.claude/**` | **GIỮ** |
| `src/app/(onboarding)/layout.tsx` + `onboarding/page.tsx` | **GIỮ**, sửa nội dung |
| `flow/onboarding-steps.ts` + test | **VIẾT LẠI** (Task 4) |
| `flow/SlideShell.tsx`, `ProgressRail.tsx`, `OnboardingFlow.tsx` | **VIẾT LẠI** (Task 5) |
| `flow/SlideCompany.tsx` + test | **XOÁ** — không còn màn tạo công ty |
| `flow/SlideData.tsx`, `DataMappingReminderDialog.tsx` (chưa commit) | **XOÁ** |
| `flow/usePassedSlides.ts` | **GIỮ**, đổi kiểu id |
| `canvas-confetti` + `@types/canvas-confetti` | **GỠ** — luồng mới không có màn chúc mừng |
| `framer-motion` | **GIỮ** |

---

### Task 1: Bảng `tenant_profile` — schema, migration, repo

Chủ: `data-pipeline` (sở hữu `src/adapters/db`). Không phụ thuộc task nào.

**Files:**
- Create: `src/adapters/db/schema/tenant-profile.ts`
- Modify: `src/adapters/db/schema/index.ts` (thêm vào barrel)
- Create: `src/core/ports/tenant-profile.ts`
- Create: `src/adapters/db/tenant-profile-repo.drizzle.ts`
- Create: `src/adapters/db/tenant-profile-repo.drizzle.test.ts`
- Generated: `drizzle/****_*.sql` qua `pnpm db:generate`

**Interfaces — Produces:**
```ts
// src/core/ports/tenant-profile.ts
export interface OnboardingProfile {
  readonly sellerKind: string | null;
  readonly currentTools: readonly string[];
  readonly channelCount: string | null;
  readonly focusChannels: readonly string[];
  readonly completedAt: Date | null;
}
export interface TenantProfileRepo {
  get(tenantId: string): Promise<OnboardingProfile | null>;
  /** Ghi ĐÈ chỉ các trường được truyền; `undefined` = giữ nguyên, `null` = xoá. */
  upsert(tenantId: string, patch: Partial<OnboardingProfile>): Promise<OnboardingProfile>;
}
```

**Quy tắc bắt buộc:**
- `null` ở mọi cột đáp án là **hợp lệ** — đó là ý nghĩa nút "Bỏ qua". **Không dùng chuỗi
  rỗng.** Mảng rỗng `[]` cũng khác `null`: `[]` = đã trả lời "không chọn gì", `null` = chưa hỏi.
- Lưu **mã ổn định** (`solo_seller`, `meta_business_suite`…), **không lưu chữ tiếng Việt**.
  Đổi câu chữ hiển thị sau này không được làm hỏng dữ liệu cũ.
- Bảng có `tenant_id`, dùng helper scope như mọi bảng khác (CLAUDE.md rule 7). Đọc
  `src/adapters/db/schema/_tenant-column.ts` và một bảng sẵn có (ví dụ `channel-group.ts`)
  làm mẫu — cấm bịa kiểu cột.
- `tenant_id` là **khoá chính**, một tenant một hồ sơ.

- [ ] **Bước 1: Đọc mẫu sẵn có**

```bash
cat src/adapters/db/schema/_tenant-column.ts
cat src/adapters/db/schema/channel-group.ts
cat src/adapters/db/schema/index.ts
```
Theo đúng khuôn đó: cách khai `tenantId`, cách khai `createdAt`/`updatedAt`, cách export.

- [ ] **Bước 2: Viết test fail trước**

`tenant-profile-repo.drizzle.test.ts` — test thuần (không cần DB thật), theo khuôn
`catalog-config-repo.drizzle.test.ts` sẵn có. Đọc file đó trước để lấy đúng cách mock.
Bốn ca bắt buộc:
1. `get` trả `null` khi chưa có hàng.
2. `upsert` chỉ truyền `sellerKind` thì **không** đụng `currentTools` đang lưu.
3. `upsert` truyền `null` thì XOÁ giá trị, khác với `undefined`.
4. `[]` được lưu và đọc lại là `[]`, không thành `null`.

- [ ] **Bước 3: Chạy test cho chắc là fail**

`pnpm exec vitest run src/adapters/db/tenant-profile-repo.drizzle.test.ts`
Kỳ vọng: FAIL — chưa có module.

- [ ] **Bước 4: Viết schema + port + repo**

- [ ] **Bước 5: Sinh migration**

```bash
pnpm db:generate
ls -la drizzle/ | tail -5
```
Phải thấy file `.sql` mới. **Đọc nội dung nó** và xác nhận chỉ tạo bảng mới, KHÔNG đụng
bảng nào khác. Có `DROP` hay `ALTER` bảng khác → dừng, báo orchestrator.

- [ ] **Bước 6: Chạy test cho chắc là pass** — `pnpm exec vitest run src/adapters/db/tenant-profile-repo.drizzle.test.ts`

- [ ] **Bước 7: Gate**

```
pnpm typecheck
pnpm exec eslint src/adapters src/core
pnpm depcruise
pnpm test
pnpm build
```
Dán output thật của tất cả.

- [ ] **Bước 8: Commit** — `feat(db): add tenant_profile for the onboarding survey`

---

### Task 2: Usecase + API cho hồ sơ onboarding

Chủ: `data-pipeline`. Phụ thuộc Task 1.

**Files:**
- Create: `src/core/usecases/onboarding-profile.ts` + `.test.ts`
- Modify: `src/composition/container.ts` (nối dây)
- Create: `src/app/api/tenants/onboarding-profile/route.ts` + `route.test.ts`
- Create: `src/ui/schemas/onboarding-profile.schema.ts`

**Interfaces — Produces:**
```ts
// core/usecases/onboarding-profile.ts
export const SELLER_KINDS = ['solo_seller','shop_owner','marketing_team','freelancer','agency','other'] as const;
export const TOOL_KINDS   = ['manual_facebook','meta_business_suite','smm_tool','platform_specific_tool','ai_platform','other'] as const;
export const CHANNEL_COUNTS = ['1-3','4-6','7-10','11-20','21-50','50+'] as const;
export const FOCUS_CHANNELS = ['facebook','tiktok','instagram','youtube','threads','zalo_oa','shopee','lazada'] as const;

export type GetOnboardingProfile = (i: {tenantId: string}) => Promise<OnboardingProfile>;
export type SaveOnboardingProfile = (i: {tenantId: string; patch: Partial<OnboardingProfile>}) => Promise<OnboardingProfile>;
export type CompleteOnboarding   = (i: {tenantId: string}) => Promise<OnboardingProfile>;
```

**Quy tắc bắt buộc:**
- **Validate ở biên** (CLAUDE.md chuẩn 2): route parse body bằng zod, giá trị không nằm
  trong 4 danh sách hằng trên → `INVALID_INPUT` có mã, **không** âm thầm bỏ qua.
- 4 danh sách hằng là **nguồn chân lý duy nhất** cho mã hợp lệ. UI import từ
  `ui/schemas/onboarding-profile.schema.ts` (bản mirror), giống cách
  `setup-progress.schema.ts` mirror usecase — `ui/` không được import `core/`.
  **Route test phải khoá hai bản không lệch nhau**, đúng như `setup-progress` đang làm.
- Role: chỉ `owner`/`admin` ghi được. Vai khác → 403.
- `PATCH` lưu từng bước; `POST .../complete` đặt `completedAt`.

- [ ] **Bước 1: Đọc mẫu** — `src/app/api/tenants/setup-progress/route.ts` và
  `src/ui/schemas/setup-progress.schema.ts`. Làm y khuôn đó, kể cả cách mirror và cách test
  chống lệch.

- [ ] **Bước 2: Viết test fail trước** cho usecase (mã lạ bị từ chối; patch một phần không
  xoá phần khác; `complete` đặt `completedAt`) và cho route (403 với editor; 400 với mã lạ;
  200 với payload hợp lệ; hai danh sách hằng không lệch giữa core và ui).

- [ ] **Bước 3: Chạy cho chắc là fail**

- [ ] **Bước 4: Viết usecase + route + schema mirror + nối `container.ts`**

- [ ] **Bước 5: Chạy cho chắc là pass**

- [ ] **Bước 6: Gate** — như Task 1 bước 7, dán output thật.

- [ ] **Bước 7: Commit** — `feat(tenants): read and write the onboarding survey profile`

---

### Task 3: Cấp tổ chức tự động

Chủ: `data-pipeline`. Phụ thuộc Task 2.

**Files:**
- Create: `src/core/usecases/ensure-default-tenant.ts` + `.test.ts`
- Modify: `src/composition/container.ts`
- Create: `src/app/api/tenants/ensure-default/route.ts` + `route.test.ts`

**Bối cảnh — đọc trước:** `src/core/usecases/create-tenant.ts` đã tồn tại, đã có luật tên/slug
và **giới hạn chống lạm dụng** đếm trong transaction của repo. Task này **dùng lại nó**,
tuyệt đối không viết bản tạo tenant thứ hai.

**Quyết định thiết kế — đọc kỹ, đây là chỗ dễ làm sai:**
Buffer tạo tổ chức ngay lúc đăng ký. MYSP **cấp lười** — tạo ở lần đầu tài khoản vào app mà
chưa thuộc tổ chức nào. Kết quả người dùng nhìn thấy là y hệt (không bao giờ gặp màn "tạo
công ty"), nhưng không phải đụng vào tầng xác thực, và giữ nguyên mọi giới hạn chống lạm
dụng đã có. Đăng ký rồi không bao giờ mở app thì không có tổ chức — điều đó không hại ai.

**Interfaces — Produces:**
```ts
export type EnsureDefaultTenant = (i: {
  accountId: string; sessionEmail: string; displayName?: string | null;
}) => Promise<{ tenantId: string; wasCreated: boolean }>;
```

**Quy tắc bắt buộc:**
- **Không tạo lần hai.** Đã có membership → trả về tenant hiện có, `wasCreated: false`.
  Đây là điều kiện quan trọng nhất của task; phải có test cho nó.
- **An toàn khi gọi đồng thời.** Hai tab mở cùng lúc không được đẻ ra hai tổ chức. Dựa vào
  ràng buộc/transaction ở tầng repo, không dựa vào kiểm tra rồi mới ghi ở tầng usecase.
- Tên mặc định: `"Công ty của tôi"`. **Không** ghép tên người dùng vào — Buffer dùng
  "My organization" chung chung, và tên hiển thị có thể là email đầy đủ, ra tên xấu.
  Người dùng đổi được ở phần cài đặt.
- Chạm giới hạn chống lạm dụng → **không nuốt lỗi**: log có context rồi ném tiếp; UI hiện
  câu tiếng Việt kèm mã.

- [ ] **Bước 1: Đọc `create-tenant.ts` và `create-tenant.test.ts` trọn vẹn**, cùng
  `src/core/ports/tenant-onboarding.ts`. Cấm đoán chữ ký.

- [ ] **Bước 2: Viết test fail trước.** Ba ca không được thiếu:
  1. Chưa có membership → gọi `createTenant`, trả `wasCreated: true`.
  2. **Đã có membership → KHÔNG gọi `createTenant`**, trả `wasCreated: false`.
  3. `createTenant` ném lỗi giới hạn → lỗi đi tiếp nguyên mã, không bị nuốt.

- [ ] **Bước 3: Chạy cho chắc là fail**

- [ ] **Bước 4: Viết usecase + route + nối dây**

- [ ] **Bước 5: Chạy cho chắc là pass**

- [ ] **Bước 6: Gate** — dán output thật.

- [ ] **Bước 7: Commit** — `feat(tenants): provision a default organisation on first entry`

---

### Task 4: Viết lại máy trạng thái luồng

Chủ: `ui-web`. Không phụ thuộc Task 1–3 (thuần, không gọi API).

**Files:**
- Rewrite: `src/ui/components/onboarding/flow/onboarding-steps.ts` + `.test.ts`
- Modify: `src/ui/components/onboarding/flow/usePassedSlides.ts` (đổi kiểu id)
- Delete: `flow/SlideCompany.tsx`, `flow/slide-company-render.test.tsx`,
  `flow/SlideData.tsx`, `flow/DataMappingReminderDialog.tsx`,
  `flow/data-mapping-reminder-render.test.tsx` (hai file cuối chưa commit)

**Interfaces — Produces:**
```ts
export const ONBOARDING_SCREENS = ['welcome','seller','tools','count','channels'] as const;
export type OnboardingScreen = (typeof ONBOARDING_SCREENS)[number];
export function isOnboardingScreen(v: unknown): v is OnboardingScreen;
/** 1..4 cho 4 bước khảo sát; welcome trả 0 (không có chấm). */
export function screenStep(id: OnboardingScreen): 0 | 1 | 2 | 3 | 4;
export const SURVEY_STEP_COUNT = 4;
export function resolveScreen(i: {
  requested: string | null;
  answered: Partial<Record<OnboardingScreen, boolean>>;
  hasStarted: boolean;
}): OnboardingScreen;
export function nextScreen(c: OnboardingScreen): OnboardingScreen | 'done';
export function previousScreen(c: OnboardingScreen): OnboardingScreen | null;
```

**Khác lần trước:** không còn cờ server nào quyết định vị trí — khảo sát không có "đã nối
Google chưa". Vị trí do URL + việc đã trả lời quyết định. Đơn giản hơn nhiều.

- [ ] **Bước 1: Viết test fail trước.** Bảy ca:
  1. Chưa bấm "Bắt đầu" → luôn `welcome`, kể cả `?step=channels`.
  2. `?step=` rác → `welcome` nếu chưa bắt đầu, ngược lại bước mở đầu tiên.
  3. Đã bắt đầu, chưa trả lời gì → `seller`.
  4. Trả lời `seller` rồi → `tools`.
  5. Cho phép lùi về bước đã trả lời.
  6. Chặn nhảy vượt quá bước mở tiếp theo.
  7. `nextScreen('channels')` → `'done'`.
  8. `screenStep('welcome')` → 0; `screenStep('channels')` → 4.

- [ ] **Bước 2: Chạy cho chắc là fail**

- [ ] **Bước 3: Viết cài đặt**

- [ ] **Bước 4: Xoá các file đã liệt kê** — `git rm` với file đã theo dõi, `rm` với file chưa.

- [ ] **Bước 5: Chạy test + `pnpm typecheck`.** Typecheck là thứ chỉ ra mọi tham chiếu còn
  sót tới file vừa xoá. Sửa hết, cấm dùng `any`.

- [ ] **Bước 6: Gate + Commit** — `refactor(onboarding): replace the setup slideshow state machine with the survey flow`

---

### Task 5: Khung và màn chào

Chủ: `ui-web`. Phụ thuộc Task 4.

**Files:**
- Rewrite: `flow/OnboardingFlow.tsx`, `flow/SlideShell.tsx` → đổi tên thành `flow/OnboardingFrame.tsx`
- Rewrite: `flow/ProgressRail.tsx` → `flow/StepDots.tsx`
- Create: `flow/GridBackdrop.tsx` + `grid-backdrop-render.test.tsx`
- Create: `flow/WelcomeScreen.tsx` + `welcome-screen-render.test.tsx`
- Modify: `src/app/(onboarding)/onboarding/page.tsx`

**Giá trị lấy từ spec §3, §4** — không đo lại, không ước lượng.

**`GridBackdrop`** dựng đúng công thức nền ở spec §4 (ô 54×54, đường 1px ở 40%, hai
gradient làm mờ rìa). Ánh xạ hex sang token Astryx. **`aria-hidden="true"`** — đây là trang
trí. Các ô logo trôi nổi cũng vậy.

**`OnboardingFrame`** (thay `SlideShell`):
```tsx
export function OnboardingFrame({
  screen, onBack, children,
}: {
  screen: OnboardingScreen;
  /** Absent trên màn chào — không có gì để lùi về. */
  onBack?: () => void;
  children: ReactNode;
}): ReactNode;
```
Bố cục theo spec §3: mũi tên lùi + logo góc trái trên, `StepDots` giữa đỉnh (ẩn ở màn chào),
nút đổi sáng/tối góc phải trên, nội dung căn giữa cả ngang lẫn dọc.

**Nút đổi sáng/tối:** MYSP **đã có** cơ chế theme (`src/ui/theme/mysp-theme.ts`, màn
`platform/appearance`). **Dùng lại cơ chế sẵn có**, cấm dựng bộ chuyển theme thứ hai.
Đọc `src/ui/hooks/useAppearance.ts` trước.

**`StepDots`:** 4 chấm 6px theo spec §2.4. **Kèm chữ "Bước n/4"** cho trình đọc màn hình —
Buffer không có, spec §9.4 yêu cầu. Chấm không bấm được.

- [ ] **Bước 1: Chạy `/ui-ux-pro-max`**
```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "welcome screen first run" --domain ux
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "decorative background aria hidden" --domain icons
```

- [ ] **Bước 2: Viết test fail trước**
- `grid-backdrop-render`: có `aria-hidden="true"`; kích thước ô 54px xuất hiện trong markup.
- `welcome-screen-render`: đúng một `<h1>`; có tên người dùng; nút "Bắt đầu"; **không** có
  chấm tiến độ trên màn chào.

- [ ] **Bước 3: Chạy cho chắc là fail**

- [ ] **Bước 4: Viết `GridBackdrop`, `StepDots`, `OnboardingFrame`, `WelcomeScreen`**

**Tên người dùng:** spec §12 — kiểm `/api/me` có trường tên hiển thị chưa
(`grep -n "name\|displayName" src/ui/schemas/me.schema.ts`). Chưa có → dùng phần trước `@`
của email và đánh dấu `// PENDING(welcome-name)`.

- [ ] **Bước 5: Chạy cho chắc là pass**

- [ ] **Bước 6: Gate**

- [ ] **Bước 7: Xem thật.** Dev server cổng 3000 đã chạy. Mở `/onboarding`, chụp ở 1710 và
  375 rộng, lưu ảnh NGOÀI repo, dán đường dẫn. Tự trả lời: lưới nền có giống spec §4 không;
  có dải trống ≥200px nào không; ở 375px có tràn ngang không; bật `prefers-reduced-motion`
  thì icon còn trôi không.

- [ ] **Bước 8: Commit** — `feat(onboarding): build the welcome screen and survey frame`

---

### Task 6: Bốn dạng thẻ lựa chọn

Chủ: `ui-web`. Phụ thuộc Task 5.

**Files:**
- Create: `flow/OptionCard.tsx` (dạng A + C), `flow/CheckOptionCard.tsx` (dạng B),
  `flow/ChannelTile.tsx` (dạng D)
- Create: `flow/StepActions.tsx` (nút Tiếp tục + Bỏ qua)
- Create: `flow/option-card-render.test.tsx`, `flow/channel-tile-render.test.tsx`

**Kích thước và màu lấy từ spec §5** — dạng A `341×58`, dạng B `375×58`, dạng C `341×47`,
dạng D `156×148`; bo 12px; **không đổ bóng**; ô emoji 32×32 bo 8px nền màu ở alpha thấp;
logo kênh 40×40 bo 8px.

**Ba chỗ CỐ Ý khác Buffer — spec §10, không được bỏ:**
1. **Đã chọn phải có dấu tick, không chỉ đổi màu viền.** Viền `#337046` một mình không đủ
   tương phản để mang nghĩa.
2. **Vùng bấm là cả thẻ**, không phải ô tick 16px — 16px dưới ngưỡng 24×24 của WCAG 2.2.
3. Nhóm một-lựa-chọn là `radiogroup` thật, đi được bằng phím mũi tên; nhóm nhiều-lựa-chọn
   là `checkbox` thật.

**`StepActions`:** nút chính **352×48** bo 12px; tắt khi chưa chọn (spec §2.1 cho màu tắt);
"Bỏ qua" 14px/500, **không gạch chân**, nằm dưới. Nút chính **đổi chữ theo trạng thái** chứ
không chỉ làm mờ — khuôn mẫu Buffer §3.9 trong tài liệu phân tích.

- [ ] **Bước 1: Chạy `/ui-ux-pro-max`**
```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "selectable card radio group" --domain ux
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "web target size" --domain ux
```

- [ ] **Bước 2: Viết test fail trước.** Sáu ca:
1. Thẻ chọn rồi có dấu hiệu **không phải màu** (tick) trong markup.
2. Nhóm một-lựa-chọn có `role="radiogroup"`, mỗi mục `role="radio"` + `aria-checked`.
3. Nhóm nhiều-lựa-chọn dùng `role="checkbox"` + `aria-checked`.
4. Thẻ có dòng phụ render đúng dòng phụ đó.
5. `ChannelTile` với `isComingSoon` render nhãn "sắp có" **dạng chữ**.
6. `StepActions` khi chưa chọn: nút chính có `disabled` và câu giải thích vì sao.

- [ ] **Bước 3: Chạy cho chắc là fail**
- [ ] **Bước 4: Viết 4 component**
- [ ] **Bước 5: Chạy cho chắc là pass**
- [ ] **Bước 6: Gate + Commit** — `feat(onboarding): add the four survey option card variants`

---

### Task 7: Bước 1 và bước 2

Chủ: `ui-web`. Phụ thuộc Task 6.

**Files:**
- Create: `flow/StepSeller.tsx`, `flow/StepTools.tsx`
- Modify: `flow/OnboardingFlow.tsx`

Nội dung câu hỏi và lựa chọn lấy **nguyên văn từ spec §6**. Mã lưu lấy từ hằng của Task 2.

- [ ] **Bước 1: Chạy `/ui-ux-pro-max`** — `"form single vs multi select" --domain ux`
- [ ] **Bước 2: Viết test fail trước** — mỗi bước: đúng số lựa chọn, đúng nhãn tiếng Việt,
  bước 1 một-chọn / bước 2 nhiều-chọn, dòng phụ của bước 2 hiện đúng chỗ.
- [ ] **Bước 3: Chạy cho chắc là fail**
- [ ] **Bước 4: Viết 2 màn, lắp vào `OnboardingFlow`**
- [ ] **Bước 5: Chạy cho chắc là pass**
- [ ] **Bước 6: Gate**
- [ ] **Bước 7: Xem thật** — chụp cả hai bước, dán đường dẫn ảnh.
- [ ] **Bước 8: Commit** — `feat(onboarding): add survey steps 1 and 2`

---

### Task 8: Bước 3 và bước 4

Chủ: `ui-web`. Phụ thuộc Task 7.

**Files:**
- Create: `flow/StepCount.tsx`, `flow/StepChannels.tsx`
- Modify: `flow/OnboardingFlow.tsx`

**Bước 4 — điểm dễ làm sai nhất.** Spec §6: liệt kê đủ kênh, nhưng mọi kênh ngoài Facebook
phải mang nhãn **"sắp có"** nhìn thấy được. Vẫn chọn được — coi như phiếu bầu nhu cầu.
**Cấm chỉ làm mờ**: mờ mà vẫn bấm được là trạng thái nói dối.

- [ ] **Bước 1: Chạy `/ui-ux-pro-max`** — `"disabled vs unavailable state" --domain ux`
- [ ] **Bước 2: Viết test fail trước** — bước 4 có đủ kênh; Facebook **không** có nhãn
  "sắp có"; mọi kênh khác **có**; nhãn là chữ chứ không chỉ độ mờ; vẫn chọn được.
- [ ] **Bước 3: Chạy cho chắc là fail**
- [ ] **Bước 4: Viết 2 màn**
- [ ] **Bước 5: Chạy cho chắc là pass**
- [ ] **Bước 6: Gate**
- [ ] **Bước 7: Xem thật** — chụp cả hai bước.
- [ ] **Bước 8: Commit** — `feat(onboarding): add survey steps 3 and 4`

---

### Task 9: Nối dây lưu trữ và kết thúc luồng

Chủ: `ui-web`. Phụ thuộc Task 2, 3, 8.

**Files:**
- Create: `src/ui/hooks/useOnboardingProfile.ts`
- Create: `src/ui/services/onboarding-profile.api.ts`
- Modify: `flow/OnboardingFlow.tsx`
- Modify: `src/ui/components/onboarding/FirstRunGate.tsx`

**Quy tắc:**
- **Lưu ngay mỗi bước** khi bấm Tiếp tục, không đợi tới cuối. Bỏ dở giữa chừng vẫn giữ
  được phần đã trả lời (spec §8).
- "Bỏ qua" cũng đi tiếp, **không** ghi gì cho bước đó (để `null`).
- Bước cuối xong → gọi `complete` → `router.replace("/")`.
- Lưu thất bại → **không** âm thầm đi tiếp. Hiện lỗi có nút thử lại, giữ nguyên lựa chọn.
- `FirstRunGate`: tài khoản chưa có tổ chức → gọi `ensure-default` rồi mới sang
  `/onboarding`. Giữ cơ chế latch (chuyển hướng đúng một lần) — lý do ghi trong file đó.
- Đã `completedAt` → **không** vào onboarding nữa.

- [ ] **Bước 1: Đọc mẫu** — `src/ui/hooks/useSetupProgress.ts` + `src/ui/services/setup-progress.api.ts`.
  Theo đúng khuôn: gate theo vai, `staleTime`, luật `retry` chỉ thử lại lỗi đáng thử.
- [ ] **Bước 2: Viết test fail trước** cho phần thuần: quyết định "có vào onboarding không"
  tách thành hàm thuần và test riêng (đã xong → không vào; chưa có tổ chức → vào; vai
  editor → không vào).
- [ ] **Bước 3: Chạy cho chắc là fail**
- [ ] **Bước 4: Viết service + hook + nối `OnboardingFlow` + sửa `FirstRunGate`**
- [ ] **Bước 5: Chạy cho chắc là pass**
- [ ] **Bước 6: Gate**
- [ ] **Bước 7: Chạy thật cả luồng** — xem Task 10 để biết danh sách; task này chỉ cần
  xác nhận lưu được và kết thúc được.
- [ ] **Bước 8: Commit** — `feat(onboarding): persist survey answers and finish into the app`

---

### Task 10: Dọn dẹp và kiểm chứng toàn luồng

Chủ: `ui-web`. Phụ thuộc mọi task trước.

**Files:**
- Modify: `package.json` (gỡ `canvas-confetti`, `@types/canvas-confetti`)
- Modify: `src/ui/components/onboarding/SetupDock.tsx`
- Modify: `src/app/(dev)/onboarding-preview/page.tsx`
- Modify: `docs/08-tien-do-du-an.md`

- [ ] **Bước 1: Gỡ dependency không còn dùng**

```bash
grep -rn "canvas-confetti" src/ || echo "khong con tham chieu"
pnpm remove canvas-confetti @types/canvas-confetti
```
Còn tham chiếu thì **dừng lại**, đừng gỡ. `framer-motion` GIỮ.

- [ ] **Bước 2: Sửa `SetupDock`** — bỏ nút "Tiếp tục thiết lập" trỏ `/onboarding` nếu có
  (onboarding giờ là khảo sát, không phải thiết lập). Dock vẫn theo dõi 6 cờ như cũ.
  Đọc file trước, đừng đổi logic `buildStepViews`.

- [ ] **Bước 3: Sửa trang preview** — thay các khối tham chiếu component đã xoá bằng
  component mới. `pnpm typecheck` sẽ chỉ ra chỗ nào hỏng.

- [ ] **Bước 4: Gate đầy đủ**

```bash
pnpm verify
```
Dán output thật. Rồi kiểm artifact:
```bash
ls -la .next/BUILD_ID && ls .next/server/app/\(onboarding\)/onboarding/
```
Build exit 0 chưa chắc đã tạo ra gì (CLAUDE.md).

- [ ] **Bước 5: Đi bộ toàn luồng trên dev server**

Ghi kết quả từng dòng:
1. Tài khoản mới chưa có tổ chức → tự cấp tổ chức, vào `/onboarding`, thấy màn chào có tên mình.
2. Bấm "Bắt đầu" → bước 1. Bốn bước đi hết → về `/`.
3. Làm lại, **bấm "Bỏ qua" cả bốn bước** → vẫn về `/`, `tenant_profile` có `completedAt`
   và bốn cột đáp án là `null`.
4. Trả lời bước 1 và 2 rồi **đóng tab**, mở lại `/onboarding` → quay đúng bước 3, hai đáp
   án cũ còn nguyên.
5. Sửa tay `?step=channels` khi mới ở bước 1 → bị kẹp lại, không màn trắng.
6. Sửa tay `?step=rác` → kẹp về màn hợp lệ.
7. Bước 4: Facebook **không** có nhãn "sắp có"; các kênh khác **có** và vẫn chọn được.
8. Đã xong onboarding rồi gõ tay `/onboarding` → **không** bắt làm lại.
9. Tài khoản vai `editor` gõ tay `/onboarding` → về `/`, không thấy khảo sát.
10. Duyệt toàn luồng **chỉ bằng bàn phím**: mũi tên đi trong nhóm radio, Space chọn
    checkbox, focus luôn nhìn thấy, đổi bước thì focus nhảy vào `<h1>`.
11. Bật `prefers-reduced-motion` → chuyển cảnh thành crossfade, icon nền ngừng trôi.
12. Đổi sáng/tối → cả 5 màn đọc được, không dòng chữ nào vô hình. Kiểm **trong app thật**,
    không chỉ ở `/onboarding-preview`.
13. `/compose`, `/sync`, `/channels`, `/data-mapping` **không đổi gì**. Đây là bài kiểm
    quan trọng: đợt này không được đụng vào chúng.

Bước nào fail thì báo fail kèm log. Cấm sửa test cho pass.

- [ ] **Bước 6: Gate `reviewer-qa`** — review toàn bộ diff 10 task, chạy lại lệnh verify.
  FAIL → agent domain sửa → gate lại.

- [ ] **Bước 7: Cập nhật `docs/08-tien-do-du-an.md`** cho E10: onboarding đổi từ wizard
  thiết lập sang khảo sát hồ sơ; việc nối nguồn quay về `SetupDock` và các route thật.

- [ ] **Bước 8: Commit** — `chore(onboarding): drop the unused confetti dependency and record progress`

---

## Cổng đối chiếu thị giác — bắt buộc với Task 5, 6, 7, 8

PM yêu cầu "làm đến khi đạt kết quả như Buffer". Để câu đó đo được chứ không phải cảm tính,
mỗi task dựng giao diện phải qua cổng này **trước khi báo xong**. Không đạt thì sửa rồi
chụp lại, không phải giải thích vì sao chưa đạt.

**Cách làm:** dev server ở cổng 3000. Chụp màn tương ứng **ở đúng khung 1400×867** (bằng
khung của ảnh tham chiếu), rồi mở ảnh tham chiếu bên cạnh và trả lời từng dòng dưới đây
bằng **đạt / không đạt**, kèm số đo thật khi lệch.

### Đối chiếu chung, mọi màn

| # | Kiểm | Chuẩn |
|---|---|---|
| 1 | Căn ngang: giữa, mọi màn. **Căn dọc: bốn bước khảo sát ở giữa (tâm ≈460); màn chào KHÔNG, tâm ≈279** | spec §3 |
| 2 | Vị trí và cỡ của logo góc trái, chấm giữa đỉnh, nút sáng/tối góc phải | như ảnh |
| 3 | Bo góc thẻ/nút | token `rounded-md` (12.8px), **không hardcode 12px** — spec §3 |
| 4 | **Không thẻ nào có đổ bóng** | phân tách bằng viền 1px |
| 5 | Chiều cao nút chính | 48px |
| 6 | Cỡ và giãn dòng tiêu đề | 28px / 35px |
| 7 | Chuyển bước là **crossfade**, không trượt ngang | ảnh `05-…` |

### Theo màn

| Màn | Ảnh đối chiếu | Điểm phải khớp |
|---|---|---|
| Chào | `00-welcome.jpg` | ô lưới 54px; icon bám lưới, logo 40px trong ô 54px; độ rõ biến thiên mạnh; nút co theo chữ (~139px) chứ không giãn hết |
| Bước 1 | `01-seller-selected.jpg` | thẻ 341×58; lưới 2 cột gap 8px; ô emoji 32px bo 8px nền pastel; **thẻ đang chọn đổi viền** |
| Bước 2 | `02-tools-selected.jpg` | thẻ 375×58; ô tick **bên phải**; dòng phụ 12px; **ô đã tick có nền đậm + dấu tick trắng** |
| Bước 3 | `03-count-selected.jpg` | thẻ 341×47 (thấp hơn bước 1 vì không có emoji); Skip có nền viên thuốc khi hover |
| Bước 4 | `04-channels.jpg` | ô 156×148 xếp dọc; logo 40px bo 8px; flex-wrap 6 ô rồi 5 ô, hàng sau căn giữa; vùng chứa ≤1110px |

### Ba chỗ CỐ Ý khác ảnh — lệch ở đây là ĐÚNG

1. Trạng thái đã chọn có **thêm dấu tick**, không chỉ đổi màu viền (spec §9.3).
2. Ô tick của thẻ kênh **hiện thường trực**, không chỉ khi hover (spec §5.4).
3. Bước nằm trên **URL** `?step=`, Buffer thì không (spec §0c).

Ngoài ba chỗ đó, lệch so với ảnh là lỗi cần sửa.

### Không được làm

- Không tự nới chuẩn rồi bảo "gần đúng rồi".
- Không dùng ảnh chụp ở khung khác 1400×867 để đối chiếu — lệch khung thì mọi số đều lệch.
- **Không chia số CSS cho tỉ lệ ảnh.** Ảnh tham chiếu là bản thu nhỏ 0.9126 của khung
  1534×950 (spec §0b). Kích thước CSS (54px lưới, 48px nút, 341×58 thẻ) là sự thật lấy từ
  DOM; vị trí dọc thì đối chiếu bằng **tỉ lệ %**, không bằng pixel tuyệt đối. Lưới dựng đúng
  sẽ trông to hơn trong ảnh ~10% — đó là đúng.
- Không kết luận đạt khi chỉ nhìn `/onboarding-preview`; trang đó render ngoài scope `Theme`.

### Task 11: Superadmin xem được số liệu khảo sát (PM giao 26/08)

Chủ: `data-pipeline` (phần dữ liệu) + `ui-web` (phần bảng). Phụ thuộc Task 2.

**Vì sao có task này.** Bốn câu khảo sát hiện được ghi đầy đủ vào `tenant_profile` nhưng
**không một màn nào đọc ra** — consumer duy nhất của `getOnboardingProfile` là chính cái
`GET` của route đó, phục vụ việc mở lại luồng dở. Thu thập dữ liệu vào một ngăn kéo không ai
mở là tính năng chưa hoàn thành, và bốn câu hỏi nhân với mọi người dùng mới là ma sát thật.

**Phần A — dữ liệu (`data-pipeline`)**
Nối `tenant_profile` vào `listTenants()` bằng LEFT JOIN, mở rộng `PlatformTenantListItem`
thêm bốn trường khảo sát + `completedAt`. Cộng một phép tổng hợp: đếm theo `seller_kind`,
xếp hạng `focus_channels`, phân bố `current_tools`.

**Phần B — bảng (`ui-web`) — PM HOÃN 26/08, KHÔNG vào trước `stg`.**
Thêm cột vào `PlatformTenantTable` sẵn có và một dải tổng hợp phía trên. Chỉ đụng
`src/ui/components/platform/**`.

Tầng dữ liệu (phần A) **đã xong và đã nằm trên nhánh** (`af661ea`) — API đã trả
`surveySummary`, chỉ chưa có màn nào đọc. Đó là trạng thái chấp nhận được: dữ liệu sẵn sàng,
giao diện làm sau. Khi làm, không cần đụng gì ngoài thư mục `platform/`.

**Luật quan trọng nhất, sai là mọi thống kê sai theo:**
`null` (chưa trả lời / đã bỏ qua) **khác** `[]` (đã trả lời "không chọn gì"). Task 1 cố ý
phân biệt hai cái này ở tầng DB. Bảng và phần đếm **phải giữ nguyên phân biệt đó** — gộp cả
hai thành gạch ngang thì con số "bao nhiêu người bỏ qua bước này" trở nên vô nghĩa.

**Ngoài phạm vi, cần dữ liệu mới:** tỉ lệ rơi theo từng bước, cohort theo thời gian, luồng
chuyển đổi từ công cụ cũ. Hiện ta **chỉ lưu đáp án cuối**, không lưu "ai bỏ qua bước nào,
lúc nào". Muốn có phễu thật thì phải ghi thêm sự kiện — đó là quyết định riêng, không gói
vào task này.

### Task 13: Backfill `completed_at` cho tenant cũ (PM quyết 26/08)

Chủ: `data-pipeline`. Phải xong **trước** khi nhánh này lên `dev`.

**Vấn đề.** Task 9 làm `FirstRunGate` kéo **mọi** owner/admin có `completed_at = NULL` vào
khảo sát. Đúng chữ spec §8, nhưng hệ quả là **tenant đang dùng sẽ bị chặn bằng một màn
toàn màn hình 4 câu hỏi** ở lần đăng nhập tới.

**Quyết định: chỉ tenant mới thấy khảo sát. Sửa bằng DATA, không bằng điều kiện runtime.**

Lý do không thêm điều kiện vào `decideOnboardingEntry`: mọi cách phân biệt "mới" với "cũ" ở
tầng chạy đều phải bám vào một mốc thời gian cứng hoặc một cờ thứ hai — cả hai đều là thứ
sáu tháng nữa không ai giải thích nổi. Một dòng migration thì tự giải thích.

**Cách làm:** migration `UPDATE`/`INSERT` đánh dấu mọi tenant **đang tồn tại tại thời điểm
chạy** là đã xong (`completed_at = now()`), bốn cột đáp án để `NULL`.

**Điều này KHÔNG làm bẩn thống kê** — đó là lý do Task 11A phân biệt bốn bucket. Những
tenant này rơi vào `noAnswer`, đúng nghĩa "không có câu trả lời", chứ không giả vờ là đã
trả lời. Ghi rõ trong comment của migration rằng đây là backfill, để người đọc báo cáo sau
này biết vì sao có một cụm `noAnswer` cùng mốc thời gian.

**Lý do sâu hơn, đáng ghi lại:** luồng này tên là `FirstRunGate` và là trải nghiệm *lần
đầu*. Biến nó thành cổng khảo sát cho mọi người là đổi bản chất của nó. Người đã dùng sản
phẩm nhiều tháng bị chặn bằng màn toàn màn hình sẽ bấm "Bỏ qua" hết — ta trả giá phiền
toái mà không thu được dữ liệu. Muốn khảo sát khách cũ thì làm bằng một bề mặt nhẹ hơn,
và đó là quyết định riêng.

### Ghi sự kiện onboarding — quyết định, chưa làm

`data-pipeline` đề xuất tái dùng `audit_log` để ghi phễu (`action: "onboarding.step_saved"`,
`payload: { step, skipped }`) — không migration, không bảng mới, 4 insert mỗi operator.

**Quyết định: KHÔNG dùng `audit_log`. Dùng bảng riêng, nhưng chưa làm bây giờ.**

Lý do, chính là điều lo (a) mà agent nêu: `audit_log` là **sổ của khách hàng** — nó tồn tại
để trả lời "vì sao công ty này bị khoá", "ai đã đổi nguồn dữ liệu". Trộn viễn thám sản phẩm
vào đó làm hỏng đúng thứ nó sinh ra để làm: 4 dòng khảo sát mỗi lần đăng ký sẽ nhấn chìm
những dòng thật sự cần đọc khi có sự cố. Rẻ về migration nhưng đắt về thứ khó sửa hơn nhiều.

Bảng `onboarding_event` riêng là đúng ngữ nghĩa. **Nhưng chưa làm**: phễu chỉ có giá trị khi
đã có lưu lượng thật, mà hiện chưa một tenant nào hoàn thành khảo sát. Dựng đường ống trước
khi có nước là tối ưu hoá sớm. Làm khi có đủ người dùng để phễu nói lên điều gì đó.

Giữ nguyên `channelCount` mà agent thêm ngoài 3 phép được giao — 2 dòng, cùng code path, và
"khách quản lý bao nhiêu trang" là phân khúc đáng giá nhất trong bốn câu.

### Lỗi CÓ SẴN tìm được khi đi bộ — không do epic này, chưa sửa

**`/join/<token>` kẹt vĩnh viễn ở "Đang kiểm tra lời mời".** `POST /api/join` trả **200**,
log ghi `Invite accepted, membership created`, DB có membership thật — nhưng màn hình không
bao giờ đổi trạng thái (theo dõi 16s, không lỗi JS). Nhánh lỗi (lời mời đã dùng, 404) cũng
không hiện gì.

Đã A/B: dán lại bản `useAdoptActiveTenant` cũ thì hiện tượng **y hệt** → lỗi có sẵn, không
do `180f2eb`.

Hậu quả: người được mời vẫn vào được công ty sau khi tải lại trang, nhưng **màn hình nói dối
họ** — họ tưởng lời mời hỏng. Đây là vi phạm trực tiếp luật "không im lặng bỏ qua lỗi" của
dự án, chỉ là ở chiều ngược lại: im lặng bỏ qua một *thành công*.

**Không sửa trong epic này** — nằm ngoài phạm vi, có sẵn từ trước, và mở rộng ngay trước lúc
promote là đúng thứ ta đã tránh ở ba quyết định trước. Cần một task riêng, và nên làm sớm:
đây là đường vào của **mọi nhân viên được mời**.

## Việc phát sinh, ngoài phạm vi epic này — ghi lại để không quên

Hai lỗi tương phản **toàn ứng dụng**, do Task 6 đo trong trình duyệt chứ không suy đoán:

1. **Vòng focus dùng chung dưới ngưỡng.** `ring-ring/50` giải ra alpha 22.5% → gần như vô
   hình, **và `--ring` lấy theo preset màu của tenant nên độ tương phản không cố định**.
   `Button` và `Input` dùng chung toàn app đang chịu cái này. WCAG 2.2 đòi ≥3:1 cho chỉ báo
   focus. Task 6 đã né bằng `ring-foreground/60` (≈3.9:1, ổn định ở cả hai theme) **chỉ
   trong phạm vi thẻ onboarding** — phần còn lại của app vẫn hỏng.
2. **`--input` chỉ đạt 1.36:1** với nền thẻ, dưới ngưỡng 3:1 của WCAG 1.4.11 cho biên một
   control. Task 6 dùng `foreground/55` (3.45:1) cho ô tick, phần còn lại của app vẫn hỏng.

Cả hai **không sửa trong epic này** — chúng đụng component dùng chung của mọi màn. Cần một
việc riêng.

## Thủ tục gộp nhánh này vào `dev` — đọc trước khi merge

Tình hình sau khi epic MinIO merge vào `dev` (`e3a655a`, 26/08): `dev` đi trước nhánh này
**23 commit**, nhánh này đi trước `dev` **12 commit**. Ba việc phải làm đúng thứ tự.

**1. Journal migration — conflict văn bản, nhưng ngữ nghĩa đơn giản.**

| | Journal |
|---|---|
| `dev` | `0…20, 21, 22, 23` (`0023_sleepy_doomsday` — của chính epic này, đã có sẵn trên dev) |
| nhánh này | `0…20, 23, 24` (thiếu 21/22 vì tách trước khi MinIO merge) |

Giải conflict: **lấy nguyên journal của `dev` rồi nối thêm entry `0024`**. Không phải đánh
số lại gì — `0024` đã mang `idx = 24` và `when = 1787737373301`, muộn hơn cả `0023`
(1787720455302). Sau khi gộp, dãy là 0→24 liên tục, `idx` và `when` đều tăng nghiêm ngặt.

**2. `.env` — không có thì app KHÔNG KHỞI ĐỘNG ĐƯỢC.**
MinIO thêm bốn biến **không có giá trị mặc định**: `MINIO_INTERNAL_ENDPOINT`,
`MINIO_PUBLIC_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`. Thiếu chúng thì lỗi là
**validate config lúc khởi động**, không phải cảnh báo thiếu tính năng — dễ tưởng nhầm là
epic này làm hỏng.

Việc phải làm sau khi gộp: chép khối `MINIO_*` từ `.env.example` sang `.env`, điền
`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` bằng giá trị bất kỳ (chúng tạo instance local), **giữ
`MINIO_PUBLIC_ENDPOINT=http://localhost:9000` — TUYỆT ĐỐI không trỏ vào `media.vannt.asia`,
đó là production**, rồi `docker compose up -d minio minio-init`.

`web` và `worker` phụ thuộc `minio-init` chạy xong; nó fail thì chúng không khởi động. Đó là
cố ý, không phải lỗi.

**3. Trạng thái hiện tại của `dev` là onboarding DỞ DANG.**
Bốn commit đầu của epic này đã nằm trên `dev` (`53fa2cb`, `2c6ef73`, `d9ccb41`, `184c20e`) —
tức wizard cũ đã bị gỡ, máy trạng thái đã thay, nhưng **màn khảo sát thật thì chưa**. `dev`
vẫn xanh (build và test pass) nhưng onboarding trên đó là bản chỗ-giữ-chỗ. **Đừng push `dev`
lên origin trước khi gộp nốt nhánh này**, nếu không origin sẽ mang một onboarding nửa vời.

### `oauth-return-cookie` giờ là code chết — quyết định: GIỮ, không gỡ lúc này

Task 10 phát hiện: sau khi Task 4 viết lại máy trạng thái, **không màn nào còn truyền
`?return=onboarding`** (`grep` chỉ còn 2 dòng comment), trong khi `resolveReturnScreen` vẫn
trỏ `/onboarding?step=data` và `?step=facebook` — **hai id bước không còn tồn tại**.

**Quyết định: không gỡ trước khi lên `stg`.** Ba lý do:
1. Nhánh đó **không thể chạy được** — không ai set cookie, nên không có đường nào tới nó.
   Vô hại, không phải bom hẹn giờ.
2. Đường mặc định (`/sync`, `/channels`) **đang chạy đúng và Task 10 vừa đo xác nhận**. Gỡ
   nghĩa là sửa 5 file qua 2 domain ngay trước lúc promote, đổi lấy rủi ro làm hỏng đúng thứ
   đang hoạt động.
3. Nó nằm trong `src/app/api/catalog/google/**` (data-pipeline) và `src/app/api/channels/**`
   (fb-publisher) — gỡ cho gọn phải điều phối hai agent cho một thao tác xoá, mà nửa vời còn
   tệ hơn để nguyên.

**Nhưng phải gỡ ở việc riêng sau `stg`.** Để lâu thì nó thành bẫy cho người đọc code sau này
tưởng nhánh đó còn sống. Đã ghi vào sổ nợ ở `docs/08`.

## Rủi ro đã biết

- **Hai job chạy song song trên một checkout.** Đây là gốc của việc commit `274c106` của job
  MinIO nuốt mất hai file E10 ở lượt trước. Mọi agent phải commit bằng plumbing và chỉ
  commit file của mình.
- **Migration trên DB dùng chung.** Ghi nhớ đã có trong dự án: `drizzle migrate` bỏ qua theo
  timestamp, `db:migrate` có thể exit 0 mà không tạo bảng nếu DB dev đã dùng chung giữa các
  worktree. Sau khi chạy migration phải **kiểm bảng thật tồn tại**, không tin mã thoát.
- **Ánh xạ token Astryx.** Spec cho hex đo được của Buffer, nhưng repo cấm hex thô. Không
  tìm được token tương ứng thì báo orchestrator, đừng tự thêm biến màu — đó là cách bảng
  màu bị trôi.
- **Bẫy chữ trên nền tối.** Trang `(dev)/onboarding-preview` render ngoài scope `Theme` nên
  không phát hiện được. Mọi kiểm tra thị giác phải làm trong ứng dụng thật.
