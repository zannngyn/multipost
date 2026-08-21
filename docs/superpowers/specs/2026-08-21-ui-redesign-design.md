# Spec — Redesign toàn bộ giao diện MYSP ("Sổ mẫu vải")

Ngày: 2026-08-21 · Trạng thái: chờ PM duyệt spec · Người quyết định: PM (Zan)

## 1. Mục tiêu và phạm vi

Làm lại toàn bộ tầng trình bày của app (14 màn + shell) theo thế giới thị giác mới và IA mới. **Không đụng logic**: giữ nguyên `src/ui/hooks/**`, `src/ui/services/**`, `src/ui/schemas/**`, toàn bộ `src/app/api/**`, `src/core/**`, `src/adapters/**`. Chỉ sửa tầng component trình bày (`src/ui/components/**`), page/layout (`src/app/(app)/**`), theme/token (`src/app/globals.css`, config theme Astryx).

Chia đợt (đã chốt với PM):

- **Đợt 1**: shell (sidenav/topbar/command palette) + IA toàn app (nav mới + redirect) + theme "Sổ mẫu vải" + màn Tổng quan `/` + màn Soạn bài `/compose`.
- **Đợt 2**: cuốn các màn còn lại (`/bulk`, `/posts`, `/products`, `/sync`, `/channels`, `/prompts`, `/members`, `/platform`, `/batches/[id]`) theo cùng hệ.

Ràng buộc đã chốt:

- Giữ **Astryx** làm nền component; redesign ở tầng layout / IA / theme / token. Không thêm dependency mới.
- Build path **code-first** (không có image generation), theo quy trình doc 12.
- Mode **Operate**: scanability và đúng kỳ vọng người vận hành đứng trên biểu đạt.
- Giữ nguyên toàn bộ hàng rào nghiệp vụ và các state đã có (loading delay 300ms / empty phân biệt first-run / error 4xx-5xx / stale / read-only support mode) — đây là điểm mạnh của codebase, chỉ thay vỏ.
- Các quyết định treo (C1/C2/C5, C3/C4, D1, D2, E1, E3) không bị đụng tới.

## 2. Direction contract — "Sổ mẫu vải" (seed key e06531fb, vòng 2, THE ROLL)

Người dùng đã chọn trên decision page sau 1 lần re-roll; các hướng thua: Bàn phiếu gửi, Thẻ kho, gate board, Bảng thẻ T, streetwear grammar, acetate manual, canon SaaS.

- **THESIS**: Cả app là sổ mẫu vải của xưởng thời trang — mỗi màu là một thẻ vải thật, mỗi mã sản phẩm là một trang mẫu, chọn màu là rút thẻ khỏi quạt. Từ chối cách sắp đặt mặc định của admin SaaS (card trắng + accent tím rải đều).
- **OWN-WORLD**: nền vải mộc chưa tẩy (off-white ấm có kết cấu rất nhẹ), thẻ màu bão hoà với cạnh bậc thang (stepped tab) làm identity, nhãn dệt (woven label) cho mã sản phẩm/metadata chạy chữ mono, kẹp kim loại làm accent tương tác. Chữ Việt subset đầy đủ; mã/số luôn mono.
- **STORY**: người vận hành mở app như mở sổ mẫu của chính xưởng mình — thấy ngay hôm nay có gì cần làm, rút thẻ soạn bài, duyệt caption trên trang mẫu, và luôn trả lời được "vì sao bài này không lên".
- **FIRST VIEWPORT** (Tổng quan): hàng số liệu đứng trên nhãn dệt (tabular, bấm được), khối "việc cần chú ý", các lô đang chạy là chồng thẻ mẫu lộ tab màu, hành động chính duy nhất "Soạn bài mới" là thẻ được rút sẵn một nửa.
- **FORM**: ứng viên #4 trong danh sách grounded vòng 2 (sau re-roll), được xúc xắc chỉ định.

Bốn kỷ luật nâng cấp (raise) là luật cứng khi build:

1. Phân cấp bằng cỡ chữ trên lưới baseline nghiêm ngặt, không bằng hộp màu nền (từ variable-font-specimen).
2. Trạng thái đang chạy chuyển động liên tục; trạng thái đã chốt đứng yên tuyệt đối (từ oscilloscope).
3. Mỗi thời điểm một sự kiện motion; chữ không bao giờ mất khả năng đọc (từ alphabet-storm).
4. Mật độ reflow theo bậc khai báo qua container query, không vỡ tự do (từ tdr-info-noise).

Ranh giới Operate: ẩn dụ thẻ vải sống ở nơi có màu/ảnh (chips màu, album, tab nav, card lô); bảng dữ liệu thuần chữ (nhật ký, members…) giữ kỷ luật bảng — ẩn dụ chỉ còn ở token màu, nhãn dệt và tab, không trang trí lên hàng dữ liệu.

Hiện thực hoá: toàn bộ qua token semantic trong `src/app/globals.css` + theme Astryx; DESIGN.md sẽ được ghi lại từ code mới ở cuối đợt 1 (đúng quy trình: rulebook viết sau khi build, từ ground truth). Direction contract đặt dạng HTML comment ở root layout theo new-work §5.

## 3. IA mới (đã duyệt cả 4 mục)

### 3.1 Sidenav: 6 nhóm/13 mục → 5 nhóm/10 mục

| Nhóm | Mục | Thay đổi so với hiện tại |
|---|---|---|
| — | Tổng quan `/` | Nội dung làm lại (mục 3.2) |
| Đăng bài | Soạn bài `/compose` · Chạy hàng loạt `/bulk` | Giữ 2 route; thống nhất UI chọn kênh + hẹn giờ |
| Theo dõi | Bài đăng `/posts` (tab **Đã hẹn** / **Nhật ký**) | Gộp `/scheduled` + `/jobs`; redirect `/scheduled → /posts?tab=scheduled`, `/jobs → /posts?tab=log` (giữ nguyên query còn lại); `/batches/[id]` giữ route, thêm breadcrumb về `/posts` |
| Dữ liệu | Sản phẩm `/products` · Đồng bộ `/sync` | Giữ |
| Cài đặt | Kênh `/channels` (tab **Page đã kết nối** / **Nhóm kênh** / **Kết nối thêm**) · Mẫu prompt `/prompts` · Thành viên `/members` (tab **Thành viên** / **Link mời** / **Lịch sử duyệt**) | Gộp `/channels/groups → /channels?tab=groups`; gộp `/access → /members?tab=history`; form dán token tách khỏi danh sách Page |
| Nền tảng | Công ty khách `/platform` (giữ `requiresPlatformRole`) | Shell hiện chỉ báo "đang ở ngoài công ty" khi ở `/platform` |

Redirect làm ở tầng route (Next.js redirect trong page/`next.config.ts`), không đụng API. `nav-items.ts` + test cập nhật theo. Command palette tự ăn theo NAV_SECTIONS mới. Quyền không đổi: `/platform` vẫn ẩn hoàn toàn với người không có platform role; `/members?tab=history` giữ guard `canManageAccess` của `/access` cũ.

### 3.2 Tổng quan `/` — bấm vào thì chuyện gì xảy ra

- Hàng số liệu (nhãn dệt, số tabular): **Bài lên hôm nay** → `/posts?tab=log` lọc hôm nay · **Đang chờ giờ** → `/posts?tab=scheduled` · **Lỗi cần xử lý** → `/posts?tab=log&status=failed` · **Mã bị chặn/tồn thấp** → `/products?loc=blocked`. Số đổi là sự kiện nhìn thấy được (raise 2).
- Khối "Việc cần chú ý": các bài lỗi gần nhất (bấm → đúng dòng trong Nhật ký, nút Chạy lại tại chỗ) + các bài sắp tới giờ.
- Hành động chính duy nhất: **"Soạn bài mới"** → `/compose`.
- Health-check hiện tại thu thành một dòng trạng thái cuối trang; bấm mở chi tiết (giữ nguyên `TenantHealthPanel` phía sau disclosure). Dữ liệu số liệu lấy từ các hook/endpoint sẵn có (`useScheduledJobs`, jobs, products); **không tạo endpoint mới trong đợt 1** — ô nào chưa có nguồn dữ liệu sẵn thì để dạng liên kết không kèm số, không bịa số.

### 3.3 Soạn bài `/compose`

- Action bar **sticky đáy viewport**: [Đăng luôn / Hẹn giờ] + đếm "N kênh · 1 bài" + lý do khi disabled. Hẹn giờ chỉ còn một chỗ tại đây (bỏ SchedulePicker giữa card).
- Một lối vào chọn kênh (dialog), dialog có thêm phần **Nhóm kênh** dùng `useChannelGroups` sẵn có.
- Rail lề trái đánh số bước: 1 Sản phẩm → 2 Ảnh/Video → 3 Kênh → 4 Caption → Đăng; mọi bước quay lại được (raise Orizuru — giữ từ vòng 1 vì đã duyệt trong đề xuất IA).
- Bỏ palette riêng `compose-theme.ts`; compose dùng chung token toàn app.
- Preview Facebook giữ sticky cột phải như hiện tại.

### 3.4 Chuẩn hoá xuyên suốt

- Một khung màn duy nhất (Astryx `Layout/LayoutHeader/LayoutContent`) cho mọi màn; "Tải lại" cố định góc phải header.
- Nhóm kênh hiển thị **tên Page** thay vì channelId thô (map từ `useChannels` sẵn có).
- `/products` dưới 1024px: inspector thành drawer — "Soạn bài" không biến mất.
- `/platform`: tách "Khoá/Mở khoá" khỏi "Vào hỗ trợ" (hành động nguy hiểm vào menu riêng).

## 4. Kiến trúc & ranh giới kỹ thuật

- Luật phụ thuộc một chiều (doc 07) giữ nguyên; không import mới xuyên tầng.
- Token: mọi giá trị qua semantic token trong `globals.css` (oklch, đủ cặp light/dark), không hex/px trần; theo chuẩn Astryx (không override `--color-*` trong `:root` của Astryx, dùng đường `astryx theme`).
- Test hiện có của UI (nav-items, nav-collapse, read-only sweep, schema tests) phải pass; test nav cập nhật theo cấu trúc mới.
- Mỗi màn gộp tab giữ nguyên component con hiện có (ví dụ `ScheduledScreen`, `JobLogScreen` thành 2 tab của `/posts` trong đợt 1 chỉ ở mức khung; redesign nội dung 2 màn đó thuộc đợt 2).

## 5. Rủi ro

- Gộp route: link cũ đã lưu/bookmark → xử lý bằng redirect giữ query; test redirect thủ công cả 3 cặp.
- Compose 597 dòng + CaptionBlock 877 dòng: sửa bố cục dễ chạm logic form → chỉ di chuyển JSX/bố cục, không đổi hook `usePublishForm`/`useCaptionFanOut`; reviewer-qa soát diff kỹ vùng này.
- Ẩn dụ thẻ vải quá tay ở bảng dữ liệu → ranh giới Operate ghi ở mục 2 là luật, `critique` cuối đợt kiểm.
- Nhóm kênh trong ChannelPickerDialog là điểm giao `/compose` × `/bulk` → chỉ thêm phần chọn theo nhóm (UI), không đổi shape dữ liệu gửi lên API.

## 6. Kiểm chứng (trước khi báo "xong" đợt 1)

1. `pnpm build` + `pnpm typecheck` + `pnpm test` (hoặc script tương ứng trong package.json) — dán output thật.
2. `pnpm dev` — preview cho PM: shell mới, Tổng quan, Compose, 3 redirect.
3. Vòng inspect có giới hạn theo doc 12: build đủ → 1 vòng inspect gộp desktop+mobile → sửa 1 đợt → tối đa 1 vòng xác nhận.
4. `node .claude/skills/impeccable/scripts/detect.mjs --json` trên file đã đổi; finish-reviewer + documenter theo quy trình impeccable; DESIGN.md ghi lại từ code mới.
5. Gate `reviewer-qa` PASS (review diff + verify output) — bắt buộc theo CLAUDE.md dự án.

## 7. Ngoài phạm vi

- Mọi thay đổi API/endpoint/schema/worker; TikTok/video Phase 2; trang marketing (mode Persuade); đổi tên thương hiệu "MYSP"; endpoint thống kê mới cho Tổng quan (đợt sau nếu PM muốn số thật cho mọi ô).
