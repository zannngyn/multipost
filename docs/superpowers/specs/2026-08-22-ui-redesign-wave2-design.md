# Spec — Redesign UI wave 2: hoàn chỉnh thế giới "Sổ mẫu vải"

Ngày: 2026-08-22 · Trạng thái: chờ PM duyệt · Người quyết định: PM (Zan)
Kế thừa: spec wave 1 (`2026-08-21-ui-redesign-design.md`), DESIGN.md "Sổ mẫu vải" (ghi từ code 22/08), backlog ledger wave 1, finish-review bàn giao đợt 2, critique 22/08 (29/40 — "thế giới cảm nhận được khi làm việc, biến mất khi cấu hình").

## 1. Mục tiêu

Câu trả lời cho câu hỏi của critique: *"Che logo đi, nhìn /channels có đoán được đây là app cho shop thời trang hiện đại không?"* — sau wave 2, câu trả lời phải là **có, ở mọi màn**. Đồng thời đóng nợ nghiệp vụ P0 (raw ID kênh) và lỗ rule-5 `skipped=Y`.

## 2. Phạm vi & ranh giới

**Phase A — cuốn nốt thế giới (thuần trình bày, như wave 1):**
được sửa `src/ui/components/**`, `src/app/(app)/**`, `src/app/globals.css`, `src/ui/theme/**`, `DESIGN.md`, và MỞ THÊM so với wave 1: `src/ui/schemas/**` (tầng validation UI — cần cho `skipped=Y`) + `next.config.ts` (redirects thật). VẪN CẤM: `src/ui/hooks/**`, `src/ui/services/**`, `src/app/api/**`, `src/core/**`, `src/adapters/**`, `src/worker/**`.

**Phase B — vòng đăng nhanh 30 mã/sáng (có thể chạm hooks):**
tách riêng, có shape/spec con riêng sau khi Phase A xong — vì "nhớ kênh giữa các bài" và "retry hàng loạt" nhiều khả năng phải sửa `usePublishForm`/`usePostJobs`. Không trộn vào Phase A để giữ rủi ro thấp.

Ràng buộc giữ nguyên từ wave 1: Astryx làm nền · mode Operate · token semantic, không hex trần · states chuẩn repo giữ nguyên hành vi · các quyết định treo C/D/E không tự quyết · flow agent team + gate reviewer-qa mọi task.

## 3. Phase A — nội dung

### 3.1 [P0] Tên Page thay raw ID ở MỌI nơi hiển thị
`fb-1121597217877301`/`fbpage-a` còn ở: filter kênh của `/posts` (Select), `ScheduledJobTable` cột kênh, checkbox danh sách kênh `/bulk` (kèm bug hiển thị: một page xuất hiện 2 lần vì nằm trong 2 nhóm), mọi chỗ khác grep ra. Dùng chung helper `resolveGroupChannelLabels`/pattern tên-trước-id-phụ đã có từ wave 1 (JobLogTable, nhóm kênh). ID chỉ hiện dạng mono phụ khi cần đối soát. `/bulk`: khử trùng lặp page giữa các nhóm khi render danh sách phẳng.

### 3.2 Cuốn 5 màn vào hệ
Theo bàn giao finish-review + nợ spec wave 1 §3.4:
- **Nền đồng nhất**: mọi màn (kể cả 3 hub, `/platform`) đứng trên nền vải mộc + panel `--card`; hết cảnh "bảng trắng generic trên hub kem". Khung màn thống nhất Astryx Layout, "Tải lại" cố định góc phải header.
- **`/posts` ruột bảng**: cột Màu thành chip vải (pattern ColorChips), trạng thái dùng token madder/turmeric/leaf + chữ (Named Status Rule), gom dòng trùng mã đa kênh, mobile có cue cuộn ngang (gradient mép) hoặc đổi sang hàng xếp chồng ở bậc hẹp.
- **`/products`**: inspector thành drawer dưới 1024px (lời hứa wave 1 §3.4 — nút "Soạn bài" không biến mất); cụm filter mobile sắp lại; chấm đỏ/vàng có chú giải chữ.
- **`/sync`**: run-list phân cấp bằng con số vấn đề (không thêm màu); side-tab `border-l-4` GoogleConnectionPanel:304 về accent nhẹ; panel chính không cắt bước ở fold.
- **`/bulk`**: theo hệ mới (đây là màn "30 mã/sáng" — ưu tiên sạch slug kỹ thuật nhất); ranh giới "đóng tab mất gì" vẽ rõ bằng copy.
- **`/prompts`**: theo hệ; sửa hai bản cùng ghi "v2"; form mở cạnh nút thay vì cuối trang.
- **`/platform`**: tách "Khoá/Mở khoá" khỏi "Vào hỗ trợ" (menu riêng cho hành động nguy hiểm — lời hứa wave 1 §3.4).

### 3.3 [Rule 5] `skipped=Y` hiển thị cho người vận hành
Callback OAuth ghi `?connected=N&new=X&skipped=Y` nhưng UI chưa bao giờ hiện `skipped`. Sửa `channel.schema.ts` (`parseConnectOutcome` đọc thêm `new`/`skipped`) + banner kết quả OAuth ở ChannelsHub nói đủ: "Nhập N Page (X mới) · Y Page bị bỏ qua — vì sao" (lý do bỏ qua theo dữ liệu route có sẵn; không có lý do chi tiết thì nói thẳng số lượng + hướng kiểm tra). Đồng thời chuyển test ghim `CALLBACK_QUERIES` sang import hằng dùng chung nếu tách được ở tầng UI mà không đụng route.

### 3.4 Giảm tải chữ (heuristic 8 — điểm 2/4 hai lần liên tiếp)
Chuẩn mới: khối intro ≤2 câu; phần quy tắc chi tiết chuyển vào disclosure "Chi tiết" tại chỗ. Áp cho: `/posts` (intro 5 câu 7 dòng), `/bulk`, các section có phụ đề dày. KHÔNG xoá thông tin — chỉ đổi liều lượng. (Ý "help tự gập sau lần đọc thứ N" của critique: KHÔNG làm — cần persistence per-user, để ngỏ.)

### 3.5 Từ vựng & song ngữ còn sót
Một từ cho một thứ: "Page" trong ngữ cảnh Facebook, "kênh" cho khái niệm chung — quét "Fanpage"/"Kênh"/"Page" về một chuẩn (đề xuất: nav & khái niệm = "Kênh"; khi chỉ đích danh Facebook = "Page"). Tab "Nhật ký đăng" vs heading "Nhật ký đăng bài" → thống nhất. Quét chuỗi tiếng Anh còn sót ngoài mục wave 1.5 đã vá.

### 3.6 Dọn kỹ thuật (từ final review + re-review wave 1)
`access/` import qua `posts/posts-tabs` → về `navigation/tab-param` · `legacy-routes.ts:26` dùng helper thay chuỗi tay · gỡ 3 ignore detector hết hạn + quyết `ignoreFiles` cho `mysp.css` (file sinh máy) · test pin `mysp-theme.ts` ↔ css đã build (M-3) · redirects thật trong `next.config.ts` cho 4 route cũ (đã cho phép) · sweep-test nit đã ghi.

### 3.7 Màn ngoài shell (nhỏ)
`/signin`: sửa "MysP"→"MYSP", "All right reserved"→"All rights reserved", bỏ form email disabled "Sắp ra mắt" chiếm chỗ (giữ 2 nút thật). Không redesign.

## 4. Phase B — vòng đăng nhanh (spec con sau Phase A)
Phạm vi dự kiến (chưa chốt): nhớ lựa chọn kênh + kiểu bài giữa các bài trong phiên; Ctrl+Enter = hành động chính; retry hàng loạt bài lỗi đủ điều kiện; ⌘K tìm mã sản phẩm. Sẽ qua `/impeccable shape` + spec riêng vì chạm hooks.

## 5. Nguyên liệu & tham khảo
- PR #33 (đã đóng): cách dựng Table/List/Layout Astryx cho products/sync/bulk/prompts/platform — tham khảo cấu trúc, KHÔNG bê palette (theme neutral) và KHÔNG bê IA cũ.
- DESIGN.md "Sổ mẫu vải" là luật thị giác; 4 raise của direction contract vẫn là luật cứng.

## 6. Kiểm chứng
Như wave 1: gate reviewer-qa mọi task + fix loop · `pnpm verify` · inspect round có giới hạn (desktop+mobile, có mắt thật qua Playwright + DEV_FAKE_SESSION) · finish-review + documenter cập nhật DESIGN.md nếu hệ nở thêm · final review toàn nhánh · PR vào dev, PM merge. Đo lại critique sau merge (kỳ vọng: heuristic 2, 4, 6, 8 tăng — mục tiêu ≥33/40).

## 7. Rủi ro
- Mở `src/ui/schemas/**`: chỉ 2 file dự kiến (`channel.schema.ts` + test); mọi thay đổi schema phải giữ test cũ pass + thêm test mới, gate soát riêng mục này.
- 5 màn × redesign = diff lớn: chia task theo màn như wave 1, mỗi màn một gate.
- `/bulk` chạm ranh giới hook (`useBulkRun`) — bố cục lại được nhưng progress model giữ nguyên; nếu phát hiện phải sửa hook thì dừng, báo PM (thuộc Phase B).
