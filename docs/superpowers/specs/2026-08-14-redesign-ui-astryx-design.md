# Thiết kế lại giao diện web MYSP trên Astryx Design System

Ngày: 2026-08-14 · Branch: `feat/ui` · Trạng thái: đã duyệt, chờ lên kế hoạch thi công

## 1. Mục tiêu và phạm vi

Thay toàn bộ lớp trình bày của web app từ shadcn/ui + Tailwind thủ công sang
Astryx Design System (`@astryxdesign/core` 0.4.0 + `@astryxdesign/theme-neutral`
0.4.0 + `@stylexjs/stylex` 0.19.0), đồng thời đổi khung điều hướng từ thanh
ngang sang thanh dọc bên trái.

**Trong phạm vi:** khung ứng dụng, 11 màn hình, hệ token, vị trí thông tin trên
từng màn.

**Ngoài phạm vi:** logic nghiệp vụ, API nội bộ, schema, hook dữ liệu. Toàn bộ
`src/ui/hooks/*`, `src/ui/schemas/*`, `src/ui/services/*` giữ nguyên. Test hiện
có phải xanh nguyên sau mỗi bước — test đỏ là dấu hiệu đã đụng nhầm vào logic.

## 2. Quyết định đã chốt

| Quyết định | Lựa chọn | Lý do |
|---|---|---|
| Chiến lược thay thế | Chuyển từng màn; **gỡ sạch shadcn** khi màn cuối ngừng dùng | Verify được sau mỗi màn, rollback rẻ; big-bang trên 8k dòng UI là rủi ro không cần thiết |
| Đích cuối của shadcn | Xoá hoàn toàn: package `shadcn`, `src/ui/components/ui/*`, và khối `:root`/`@theme inline` trong globals.css | Không để lại hai hệ token |
| Theme | `@astryxdesign/theme-neutral/built` | Không cần build step; đổi sang brand theme sau vẫn được vì cùng hệ token |
| Cách trình bày dữ liệu dày | Rows + inspector panel | Đúng archetype "tracker / work tool" của Astryx; giữ ngữ cảnh danh sách khi soi chi tiết |
| Thứ tự thi công | Shell → màn dày → wizard | Chốt pattern trên màn đơn giản trước, wizard là màn khó nhất nên làm sau |
| Cấu trúc route | Route group `src/app/(app)/` | Shell khai báo một lần thay vì lặp 10 chỗ; URL không đổi; `/signin` nằm ngoài group |
| TenantHealthPanel | Thu vào `Collapsible` đáy màn Tổng quan | Giữ đường kiểm tra toàn tuyến UI→API→DB nhưng không chiếm chỗ đầu trang |

## 3. Kiến trúc khung

### 3.1 Cây route

```
src/app/
  layout.tsx          # chỉ html/body/font/Providers — không có shell
  signin/page.tsx     # ngoài (app): không nav
  (app)/
    layout.tsx        # LinkProvider > Theme > AppShell + SideNav
    page.tsx          # Tổng quan
    compose/ bulk/ scheduled/ jobs/ products/ sync/ channels/ prompts/
    batches/[batchId]/
```

Hiện tại 10 file `page.tsx` mỗi file tự `import { AppNav }` rồi render kèm
container `max-w-*` riêng. Route group xoá sạch lặp lại đó.

### 3.2 Thứ tự CSS layer

Ghi trong `src/app/globals.css`, giữ nguyên toàn bộ `@theme inline`, `:root`,
`.dark` và `@layer base` của shadcn đang có:

```css
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;

@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@import "@astryxdesign/core/reset.css";
@import "@astryxdesign/core/astryx.css";
@import "@astryxdesign/theme-neutral/theme.css";
```

**Không nạp `@astryxdesign/core/tailwind-theme.css` cho tới B9.** Xem mục 5.5.

### 3.3 SideNav

`resizable={{defaultWidth: 256, minWidth: 240, maxWidth: 280, autoSaveId: "mysp-nav"}}`,
`collapsible`, chia 4 section:

| Section | Mục |
|---|---|
| Vận hành | Tổng quan · Soạn bài · Chạy hàng loạt |
| Theo dõi | Bài đã hẹn (`endContent` = số bài chờ) · Nhật ký đăng bài |
| Dữ liệu | Sản phẩm · Đồng bộ dữ liệu |
| Cấu hình | Nhóm kênh · Mẫu prompt |

Footer: tên người đăng nhập + nút Đăng xuất. `SideNavItem` nhận `href`,
`isSelected`, `icon`/`selectedIcon`; điều hướng client-side qua `LinkProvider`
bọc `next/link`. `/batches/[batchId]` không có mục nav — nó là đích deep-link từ
Nhật ký và từ màn tạo lô.

`aria-current` và trạng thái chọn do `isSelected` lo; giữ nguyên yêu cầu a11y
của `AppNav` cũ (người dùng screen reader phải biết mình đang ở đâu mà không cần
đọc màu).

### 3.4 Responsive contract

Ghi thành comment ở gốc frame:

```
> 1024px   nav 256 | content | inspector 380
<= 1024px  inspector overlay lên content (không nén content)
<= 768px   nav thu vào MobileNav drawer; toolbar hành động xuống dòng
```

## 4. Thiết kế từng màn

Mỗi mục theo cùng một khuôn: **màn này là gì · cần gì · Astryx có gì · đặt đâu**.

### 4.1 `/` Tổng quan

Hiện chỉ có ô nhập tenant + nút kiểm tra — đó là màn chẩn đoán, không phải tổng
quan. Màn này phải trả lời "hôm nay có gì cần tôi làm".

Astryx: template `dashboard`; `Card` + `Grid` cho KPI tile; `List`/`ListItem` +
`StatusDot` cho danh sách việc; `Banner` cho cảnh báo; `Collapsible`.

Bố cục: hàng 4 KPI trên cùng, dưới là hai danh sách rows — "Bài lỗi gần đây" và
"Sắp tới giờ đăng" — mỗi dòng click sang `/jobs` hoặc `/scheduled`.
`TenantHealthPanel` xuống đáy trong `Collapsible` nhãn "Tình trạng hệ thống".

Ràng buộc: KPI dựng từ hook sẵn có (`usePostJobLog` có filter, `useScheduledJobs`,
`useSyncStatus`, `useCatalogProducts`). **Không thêm endpoint mới.** Muốn KPI tổng
hợp thật thì là task backend riêng, phải hỏi trước.

### 4.2 `/products` Sản phẩm

Danh sách mã: mã nào đăng được, mã nào bị chặn và vì sao. Cần lọc trạng thái,
tìm theo mã/tên, tổng số, tải thêm theo cursor, lý do chặn.

Astryx: `PowerSearch`, `SegmentedControl` (thay `ProductTotalsBar` 3 nút — count
đặt trong `SegmentedControlItem`), `Table`, `StatusDot`, `MetadataList`,
`Banner`, `EmptyState`, `Skeleton`, `LayoutPanel`.

Bố cục: search + segmented ở `LayoutHeader`. Bảng edge-to-edge còn 5 cột — Mã ·
Tên · Chủng loại · Tồn · Ảnh/video — với `StatusDot` đầu dòng. **Bỏ cột "Đăng
bài"**: nút hành động trong bảng dày làm rối mắt. Chọn dòng mở `LayoutPanel`
380px chứa `MetadataList` (mã, tên, chủng loại, mùa vụ, tồn, thông điệp tồn kho),
lý do chặn dạng `Banner`, nút "Soạn bài" ở đáy panel.

Giữ nguyên: bộ lọc nằm trong URL, hai empty state phân biệt ("chưa đồng bộ lần
nào" vs "không khớp bộ lọc"), skeleton delay 300ms.

Nhắc lại rule nghiệp vụ 2: tồn kho và lý do chặn là dữ liệu nội bộ, chỉ sống ở
bảng và panel này, không bao giờ đi vào caption.

### 4.3 `/jobs` Nhật ký đăng bài

Mỗi dòng là một bài trên một kênh. Đây là màn trả lời "vì sao bài này không
lên?" mà không phải mở log.

Template `incident-console` khớp gần 1-1: grouped dense rows, PowerSearch,
segmented control trạng thái, inspector panel resizable.

Bảng hiện có 8 cột, riêng cột "Lý do / kết quả" chiếm 24% và ôm cả `userMessage`,
link Facebook, `lastErrorCode`, link lô — đúng bằng nội dung của panel.

Bố cục mới: bảng còn 5 cột — `Timestamp` · Mã SP · Kênh · `StatusDot` trạng thái ·
Lần thử. Panel chứa `MetadataList` (batchId, postJobId, màu, lastErrorCode),
`Banner` cho `userMessage`, `Link` icon `externalLink` mở bài trên Facebook, nút
"Chạy lại" và `Toast` báo kết quả (thay dải thông báo xanh hiện tại).

Giữ nguyên: `canRetry` do server quyết, UI không tự suy ra từ status.

### 4.4 `/scheduled` Bài đã hẹn

Bài đang chờ tới giờ, đã nhóm theo ngày sẵn — khớp `table-grouped` +
`useTableGroupedRows`.

Astryx: `DateRangeInput` (thay hai ô date rời), `Selector` (thay `Select` kênh),
`DateTimeInput` trong dialog đổi giờ, `AlertDialog`, `Timestamp`, `MoreMenu`,
`useContainerReveal`.

Bố cục: bộ lọc ở header; group header mỗi ngày mang count. Hai hành động Đổi giờ
và Huỷ vào `MoreMenu` cuối dòng, dùng `useContainerReveal` để chỉ hiện khi hover
hoặc focus bàn phím — không phơi hai nút trên mọi dòng. Huỷ dùng `AlertDialog` vì
là hành động phá huỷ.

Giữ nguyên: giờ hiển thị theo múi giờ máy người dùng; `nowMs = 0` trên server để
không render nhầm "Hôm nay".

### 4.5 `/sync` Đồng bộ dữ liệu

Khai báo nguồn Drive/Sheet, chạy đồng bộ, xem số liệu và các file bị bỏ qua.

Astryx: template `settings`; `FormLayout` + `Field` + `TextInput` cho nguồn;
`AlertDialog` xác nhận chạy (thay `RunSyncButton` tự chế); `Card` + `Grid` cho
`SyncCountsGrid` — đây là widget thật nên Card hợp lệ; `Table` cho bảng vấn đề;
`Banner` cho cảnh báo đổi nguồn và schema drift; `ProgressBar` khi đang chạy;
`Toolbar` cho bộ chọn tenant.

Bố cục: một cột, không panel. Ô "Mã đơn vị" đang nằm giữa màn — đưa lên `Toolbar`
đầu trang vì nó là bộ chọn ngữ cảnh chứ không phải nội dung. Thứ tự giữ nguyên:
nguồn → nút chạy → kết quả, vì mọi con số chỉ có nghĩa khi biết nó đến từ đâu.

### 4.6 `/channels` Nhóm kênh

Form "Tạo nhóm" đang nằm **trên** danh sách. Đảo lại: danh sách là nội dung chính
(`List`/`Item` rows), nút "Tạo nhóm" ở `LayoutHeader` mở `Dialog`, chọn nhóm mở
panel sửa. `AlertDialog` cho xoá.

### 4.7 `/prompts` Mẫu prompt

Astryx: `Table` cho danh sách phiên bản, `Token` đánh dấu bản đang dùng,
`CodeBlock` xem nội dung prompt, `Collapsible` cho `PromptVariablesHelp`,
`Dialog` cho form phiên bản mới.

`PromptVersionForm` (260 dòng) chuyển vào `Dialog` thay vì nằm trong luồng trang.
Chọn một phiên bản mở panel: `CodeBlock` nội dung + nút "Đặt làm bản đang dùng".

### 4.8 `/compose` Soạn bài

Wizard 3 bước: sản phẩm → caption → xem lại, rồi tạo lô. Màn khó nhất.

Astryx: `Thumbnail` + `SelectableCard` + `Grid` cho MediaGrid; `Lightbox` xem ảnh
to; `TabList` chuyển caption giữa các kênh; `TextArea` + `Field`;
`SegmentedControl` Đăng ngay / Hẹn giờ; `Banner`; `AlertDialog` xác nhận tạo lô.

Bố cục ba vùng: rail bước 240px (trái) | nội dung bước (giữa) | `PublishPanel`
380px (phải, chỉ xuất hiện ở bước 3).

**Banner cảnh báo tồn kho luôn ở đỉnh vùng giữa, không bao giờ trong panel** — đó
là lý do dừng, người duyệt phải thấy trước khi bấm.

Giữ nguyên: focus chuyển sang heading của bước mới, thông báo bước qua vùng
`aria-live`, thông báo "đã đưa bạn về bước 1" khi mất dữ liệu tạm.

Xem mục 5.1 về việc `Stepper` không dùng được.

### 4.9 `/bulk` Chạy hàng loạt

Dán nhiều mã, chọn kênh, chạy, theo dõi tiến độ.

Astryx: `Tokenizer` biến danh sách mã dán vào thành token nhìn thấy được — mã sai
lộ ra ngay thay vì chờ submit; `CheckboxList` chọn kênh; `Table` + `ProgressBar`
cho tiến độ; `Collapsible`.

Bố cục: khi bắt đầu chạy, form thu vào `Collapsible` để bảng tiến độ chiếm hết
chiều cao.

### 4.10 `/batches/[batchId]` Chi tiết lô

Astryx: template `detail-page`; `Breadcrumbs` (Nhật ký → lô); `MetadataList` tóm
tắt lô; `Table` các kênh; `ProgressBar` tiến độ.

Giữ là trang riêng, không panel — đây đã là đích deep-link.

### 4.11 `/signin` Đăng nhập

Template `login-card` + `AppShellContentOnly`. Nằm ngoài route group `(app)` nên
không có nav. Giữ Server Component và `<form action>` thật như hiện tại.

## 5. Ràng buộc kỹ thuật đã xác minh

### 5.1 `Stepper` không dùng được

Template `StepperMultiStepForm` import `{Stepper, Step}` từ `@astryxdesign/lab`.
Trên npm, `@astryxdesign/lab` có `latest = 0.0.0-bootstrap.0` (placeholder); chỉ
nhánh `canary = 0.4.0-canary.fff8412` mới có nội dung thật. Không cài canary vào
dự án.

Thay bằng step rail tự dựng: `List` + `ListItem` + `StatusDot` + `Divider` đặt
trong `LayoutPanel` slot trái. Vừa là stepper dọc, vừa cho phép quay lại bước đã
qua — thay `WizardStepper` hiện tại.

### 5.2 Không dùng `xstyle`

`xstyle` cần StyleX compile lúc build; Next 16 + Turbopack chưa cấu hình plugin
StyleX. Chỉ dùng props component, và khi cần thì `className` với utility Tailwind
đã nối token qua bridge. Không `style={{}}`, không hex/px thô, không `@apply`.

Nếu sau này thật sự cần `xstyle` thì phải thêm bundler plugin — task riêng, không
gộp vào đợt này.

### 5.3 Icon

Icon registry của Astryx chỉ có 28 tên tiện ích (close, search, funnel, calendar,
externalLink…), không có icon nghiệp vụ. `IconType` nhận thẳng
`ComponentType<SVGProps<SVGSVGElement>>`, nên nav dùng icon từ `lucide-react` đã
có sẵn trong dependencies. **Không thêm dependency mới.**

### 5.4 RSC

Barrel `@astryxdesign/core` có `'use client'` ở đầu file, nên import từ barrel tự
tạo client boundary. Các `page.tsx` giữ nguyên vai trò Server Component lo phần
auth; Astryx chỉ xuất hiện trong component đã `"use client"`.

### 5.5 Vì sao bridge Tailwind phải hoãn tới B9

`@astryxdesign/core/tailwind-theme.css` map lại chính những tên biến mà shadcn
đang dùng, nhưng sang nghĩa khác:

| Biến | shadcn | Astryx bridge |
|---|---|---|
| `--color-primary` | `var(--primary)` — màu nền nút | `var(--color-text-primary)` — màu chữ |
| `--color-card` | `var(--card)` | `var(--color-background-card)` |
| `--color-muted` | `var(--muted)` | `var(--color-background-muted)` |
| `--color-border` | `var(--border)` | `var(--color-border)` |
| `--radius-lg` | `var(--radius)` | `var(--radius-container)` |

Nạp bridge từ B0 sẽ đổi nghĩa `bg-primary`, `bg-muted`, `bg-card`… ở mọi màn
chưa chuyển. Đã đếm: khoảng 470 lượt dùng class tiện ích gắn token shadcn trong
`src/ui` và `src/app` (`text-muted-foreground` 144, `bg-muted` 89, `bg-card` 24,
`text-warning-foreground` 22…). Vì vậy bridge chỉ được nạp ở B9, sau khi màn
cuối cùng đã hết class shadcn.

Ngược lại, `astryx.css` và `theme-neutral/theme.css` chỉ định nghĩa token có
namespace (`--color-text-primary`, `--color-background-surface`…) — đã kiểm tra,
không có biến trần nào trùng shadcn — nên nạp được ngay từ B0.

### 5.6 Lộ trình gỡ shadcn

shadcn nằm ở ba tầng, gỡ theo thứ tự ngược với thứ tự phụ thuộc:

1. **Class tiện ích** (~470 lượt) — gỡ theo từng màn, cùng lúc với việc chuyển
   màn đó sang Astryx. Đây là tầng chịu lực nên không thể gỡ trước.
2. **Primitive** `src/ui/components/ui/{button,badge,input,textarea,select,dialog}.tsx`
   — 37 file import. Xoá từng primitive ngay khi import cuối cùng của nó biến
   mất (`select` và `dialog` chỉ có 2 chỗ nên chết sớm).
3. **Package + token** — `shadcn` trong dependencies, `@import "shadcn/tailwind.css"`,
   `tw-animate-css` nếu hết dùng, và khối `:root`/`.dark`/`@theme inline` trong
   `globals.css`. Xoá ở B9 cùng lúc với việc nạp bridge.

Điều kiện thoát B9: `grep -r "components/ui/" src/` không còn kết quả, và
`grep -rE "(text|bg|border)-(muted|card|destructive|warning|success)" src/`
không còn kết quả.

### 5.7 Hạ tầng test

`vitest.config.ts` đặt `environment: "node"`, không có jsdom cũng không có
Testing Library. Mọi test hiện có là test logic thuần (schema, `present-api-error`),
**không có test render component nào**.

Vì vậy TDD chỉ áp dụng được cho phần logic thuần tách ra được (ví dụ hàm khớp
route đang active của nav). Phần bố cục và giao diện kiểm chứng bằng `pnpm verify`
cộng với chạy thật `pnpm dev`. Thêm jsdom + Testing Library là quyết định thêm
dependency — phải hỏi trước, không tự làm.

## 6. Thứ tự thi công

| Bước | Nội dung |
|---|---|
| B0 | Nền + shell: globals.css layer, route group `(app)`, LinkProvider, Theme, AppShell, SideNav; gỡ `AppNav` khỏi 10 page |
| B1 | Sản phẩm — chốt pattern rows + inspector |
| B2 | Nhật ký đăng bài |
| B3 | Bài đã hẹn |
| B4 | Tổng quan |
| B5 | Đồng bộ dữ liệu |
| B6 | Nhóm kênh + Mẫu prompt |
| B7 | Soạn bài |
| B8 | Chạy hàng loạt + Chi tiết lô + Đăng nhập |
| B9 | Gỡ sạch shadcn tầng 3 (xem 5.6), nạp `tailwind-theme.css`, audit `web-design-guidelines` |

Primitive shadcn được xoá dần trong B1–B8 ngay khi mất import cuối cùng, không
dồn hết sang B9.

Mỗi bước chạy `pnpm verify` (typecheck · lint · depcruise · test · build) và phải
qua gate `reviewer-qa` theo luật repo trước khi được coi là xong.

## 7. Skill sẽ dùng

Nhóm 1 kèm mọi màn: `core-component-reuse` + `web-component-reuse`,
`core-accessibility` + `web-accessibility`, `core-feedback-states` +
`web-feedback-states`, `core-design-tokens` + `web-design-tokens`.

Theo bước: `core/web-layout-shell` (B0) · `core/web-data-table` +
`core/web-data-list-query` (B1–B3) · `core/web-form-architecture` (B5–B6) ·
`core/web-wizard` (B7) · `web-design-guidelines` (B9).

## 8. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Đổi trình bày làm vỡ test hiện có | Test đỏ = đã đụng nhầm logic; dừng và xem lại, không sửa test cho pass |
| Inspector panel làm hỏng deep-link hiện có (`/jobs?batchId=`) | Trạng thái chọn dòng cũng đẩy vào URL, cùng cách bộ lọc đang làm |
| Bốn màn dùng chung pattern rows+inspector nhưng làm lệch nhau | B1 chốt pattern và tách thành component dùng lại trước khi sang B2 |
| Astryx 0.4.0 lên bản mới giữa chừng | `astryx upgrade --apply` sau mỗi lần bump core, chạy trong một commit riêng |
