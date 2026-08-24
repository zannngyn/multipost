# First-run: modal 2 bước + dock 6 bước

Ngày: 2026-08-24 · Trạng thái: đã duyệt (PM duyệt trong phiên brainstorming)

## 1. Vấn đề

Tài khoản đăng nhập xong nhưng chưa thuộc công ty nào hiện bị `TenantBoundary`
thay TOÀN BỘ màn hình bằng `OnboardingPanel` — hai thẻ xếp dọc "tạo công ty" /
"dán link mời". Ba hệ quả:

1. Route chính không còn là tổng quan; khách không thấy sản phẩm sẽ dùng.
2. Sau khi tạo công ty, khách không biết còn phải làm gì để đăng được bài.
3. Bộ `FirstRunChecklist` đã viết (5 bước) chỉ sống ở trang dev preview, chưa
   nối vào app thật.

## 2. Kết quả mong muốn

- Route chính VẪN ở tổng quan; một modal 2 bước đè lên trên.
- Xong modal là app chạy ngay, không phải F5.
- Sau đó một dock nhỏ góc dưới phải cho biết còn bước nào để đăng được bài.

## 3. Quyết định đã chốt

| # | Câu hỏi | Chốt |
|---|---|---|
| Q1 | Bước 02 mời nhân viên bằng email? | KHÔNG. Repo không có mailer. Chỉ sinh link mời theo vai trò + chép link. |
| Q2 | Chip "Đội bạn làm gì nhiều nhất?" | Bỏ. Chưa có gì tiêu thụ giá trị đó. |
| Q3 | Bộ bước của dock | 6 bước như thiết kế, dock là bản thu nhỏ; "Mở đầy đủ" mở `FirstRunChecklist` đầy đủ trên tổng quan. |
| Q4 | Modal bỏ qua được? | Không. `purpose="required"`. Nền tổng quan làm mờ. |
| Q5 | Dock hiện ở đâu | Mọi trang trong app shell. |
| Q6 | Ai thấy dock | Chỉ owner/admin. |
| Q7 | Bấm X đóng dock | Thu thành pill tròn, nhớ ở localStorage theo tenant. |
| Q8 | Nguồn 6 cờ | Một endpoint mới `GET /api/tenants/setup-progress`. |

## 4. Sáu bước và nguồn sự thật

| # | id | Nhãn | Xong khi | Khoá tới khi |
|---|---|---|---|---|
| 1 | `tenant` | Tạo tổ chức | luôn xong | — |
| 2 | `google` | Kết nối Google Drive | `connectGoogleDrive.getGoogleConnection()` báo đã nối | — |
| 3 | `source` | Nối Google Sheet sản phẩm | `catalogConfig.findCatalogSource()` ≠ null | bước 2 xong |
| 4 | `facebook` | Kết nối trang Facebook | có ≥1 channel | — |
| 5 | `group` | Tạo nhóm kênh | có ≥1 channel group | bước 4 xong |
| 6 | `firstPost` | Đăng bài đầu tiên | có ≥1 post_job `published` | bước 3 VÀ 4 xong |

Bước bị khoá luôn kèm câu lý do (`StepAction.disabledReason` đã có sẵn trong
`first-run.types.ts`) — không có nút chết không giải thích.

`requiredCount` = 5 (bước 6 là đích, không tính vào tiến độ thiết lập).
`isReady` = bước 3 và 4 đều xong → đủ điều kiện soạn bài.

## 5. Kiến trúc

Luật một chiều (docs/07 §2) giữ nguyên: `app → composition → adapters → core`.

### 5.1 core

`src/core/usecases/get-setup-progress.ts`

```
makeGetSetupProgress({ google, catalogConfig, channels, channelGroups, postJobs, logger })
  -> (input: { tenantId }) => Promise<SetupProgress>
```

`SetupProgress = { steps: readonly SetupStepFlag[]; doneCount; requiredCount; isReady }`
với `SetupStepFlag = { id: SetupStepId; isDone: boolean }`.

Edge case trước: `tenantId` không hợp lệ → `INVALID_INPUT` trước khi chạm repo.
Mỗi nguồn được đọc song song (`Promise.all`); một nguồn hỏng KHÔNG được nuốt —
usecase để lỗi nổi lên, route map sang HTTP.

Ngoại lệ có chủ đích: `getGoogleConnection` ném `GOOGLE_OAUTH_NOT_CONFIGURED`
khi deployment thiếu biến môi trường. Đó không phải lỗi của tenant và không được
làm sập cả dock — bắt riêng MÃ ĐÓ, log warn có `tenant_id`, coi bước 2 là chưa
xong. Mọi mã khác vẫn ném lên.

### 5.2 app

`src/app/api/tenants/setup-progress/route.ts` — GET, `dynamic = "force-dynamic"`,
`requireTenantContext(tier: "R", minRole: "admin")`. Mỏng theo hợp đồng: uỷ
quyền + map lỗi, không nhánh nghiệp vụ.

`minRole: "admin"` vì chỉ owner/admin thấy dock; editor/viewer gọi vào nhận 403
và hook của họ không bao giờ gọi.

### 5.3 ui

Mới:

- `src/ui/schemas/setup-progress.schema.ts` — zod parse response (không tin dữ
  liệu ngoài, kể cả API nhà).
- `src/ui/services/setup-progress.api.ts` — transport + cache key.
- `src/ui/hooks/useSetupProgress.ts` — `enabled` chỉ khi `isResolved` và
  `role ∈ {owner, admin}`; `staleTime` 30s; không retry 4xx.
- `src/ui/hooks/useSetupDockState.ts` — bung/thu, localStorage theo `tenantId`,
  đọc/ghi bọc try/catch (Safari private mode ném).
- `src/ui/components/onboarding/setup-steps.ts` — HÀM THUẦN: 6 cờ → `StepView[]`
  (nhãn, mô tả, state, lý do khoá, href). Toàn bộ luật khoá nằm ở đây, test
  được không cần render.
- `src/ui/components/onboarding/FirstRunWizard.tsx` — Dialog 2 bước.
- `src/ui/components/onboarding/WizardRail.tsx` — cột trái tối.
- `src/ui/components/onboarding/WizardStepCreate.tsx` — bọc `CreateTenantForm`.
- `src/ui/components/onboarding/WizardStepInvite.tsx` — vai trò + sinh link.
- `src/ui/components/onboarding/SetupDock.tsx` — dock + pill.

Sửa:

- `first-run.types.ts` — `StepId` thành 6 giá trị, `ordinal` 1..6.
- `FirstRunChecklist.tsx`, `FirstRunStepRow.tsx`, `first-run.fixtures.ts` —
  theo bộ 6.
- `TenantBoundary.tsx` — nhánh `hasNoMembership` render `{children}` + lớp mờ +
  wizard, thay `OnboardingPanel`.
- `AppFrame.tsx` — gắn `SetupDock`.
- `OverviewScreen.tsx` — chèn `FirstRunChecklist` đầy đủ khi chưa xong.
- `(dev)/onboarding-preview/page.tsx` — thêm wizard + dock.

Xoá: `OnboardingPanel.tsx` (wizard thay thế). `JoinInviteForm` GIỮ — rail dùng
lại.

## 6. Vì sao render tổng quan thật sau lớp mờ là an toàn

`useActiveTenant().isResolved` = `data !== undefined && (tenantId !== null ||
isBootstrapAdmin)`. Khi `hasNoMembership` thì `tenantId === null` và
`isBootstrapAdmin === false` → `isResolved === false`. Mọi hook tenant-scoped
đều `enabled: isResolved`, nên KHÔNG request nào bắn ra: tổng quan chỉ vẽ khung
rỗng. Một test canh giữ bất biến này.

Bootstrap admin không bị nhốt: `hasNoMembership` đã loại họ ra. Các route
tenant-independent (`/platform`) vẫn đi qua `isTenantIndependentPath` trước.

## 7. Không F5

`useCreateTenant` → `useAdoptActiveTenant()`: server đã set cookie tenant, client
`removeQueries` sạch cache rồi đọc lại `/api/me`. Boundary re-render sang nhánh
có tenant ngay trong cùng một lượt tương tác. Bổ sung duy nhất: invalidate key
`setup-progress` sau khi mint invite.

## 8. Lối thoát khỏi modal

`purpose="required"` khoá cả Escape lẫn backdrop, tức là khoá luôn nút đăng xuất
trên top bar. Rail phải có dòng "Đăng xuất" — nếu không, một tài khoản chưa có
công ty sẽ bị nhốt vĩnh viễn. Đây là yêu cầu bắt buộc, không phải trang trí.

## 9. Thị giác & chuyển động

Theo motion contract sẵn có của `OverviewScreen`: mỗi lúc một sự kiện, thứ đã
yên thì đứng yên, mọi hiệu ứng `motion-safe:`, không cái nào lặp vô hạn (trừ
skeleton, vốn `aria-hidden` và chỉ sống khi query đang bay).

- Mở modal: backdrop fade, panel scale 0.98→1.
- 01→02: pane phải trượt 12px + fade 140ms; mốc rail morph tròn → ✓.
- Dock: trồi lên từ đáy (16px + fade).
- Bước vừa xong: dòng đó flash nền vàng nhạt một lần rồi tắt; thanh tiến độ
  chạy mượt tới giá trị mới.
- Thu/bung: morph bằng transform, không unmount.
- 6/6: đổi sang thẻ "Xong rồi", tự thu sau đó.

## 10. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Một hook nào đó quên `enabled: isResolved` → gọi API khi chưa có tenant | Test quét toàn bộ hook tenant-scoped |
| Modal `required` nhốt khách | Dòng "Đăng xuất" trong rail |
| Dock ở mọi trang = thêm query | `enabled` theo role + tắt khi 6/6 + `staleTime` 30s |
| Modal 2 cột trên màn hẹp | Dưới `md` xếp dọc, rail thu thành header |
| `GOOGLE_OAUTH_NOT_CONFIGURED` làm sập dock | Bắt riêng mã đó, coi bước 2 chưa xong |

Không migration. Không dependency mới.

## 11. Kiểm chứng

`pnpm verify` (typecheck · lint · depcruise · theme:check · test · build), rồi
dựng `pnpm dev` và chụp màn hình thật ba trạng thái: bước 01, bước 02, dock.
