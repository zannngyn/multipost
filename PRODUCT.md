# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hai vai trong mỗi tenant (shop thời trang):

- **Chủ shop / quản lý**: cấu hình kênh Facebook, kết nối Drive/Sheet, mời thành viên, quản lý tenant. Cũng là người quyết định mua khi sản phẩm bán ra ngoài.
- **Nhân viên vận hành** (bán hàng/marketing, không rành kỹ thuật): soạn bài theo lô, duyệt caption AI từng kênh, theo dõi trạng thái đăng và cảnh báo tồn kho — công việc lặp lại hằng ngày.

Ngoài tenant còn vai **platform admin/support** của MYSP: quản trị vỏ ngoài, support mode có audit (docs/09).

Hoàn cảnh sử dụng chính: **desktop tại văn phòng**, màn hình lớn, soạn theo lô. Mobile chỉ cần xem được, không phải kênh vận hành chính.

## Product Purpose

Công cụ đăng bài bán hàng tự động lên Facebook và TikTok, AI viết caption riêng cho từng kênh. Thay thế quy trình thủ công: tải ảnh từ Drive, tra Sheet, viết caption, đăng từng bài từng kênh. Thành công = nhân viên đăng một lô sản phẩm lên nhiều kênh trong vài phút, không lọt bài sai (hết hàng, lộ giá nội bộ, đăng trùng), và mọi lỗi đều trả lời được "vì sao bài này không lên".

Phase hiện tại: Phase 1 — MVP Facebook (ảnh). TikTok/video/hẹn lịch là Phase 2; tự tải media lên là Phase 3.

## Positioning

**SaaS thật sự** — sẽ mở cho shop khác dùng, không chỉ nội bộ; self-service tenant + link mời đã có. UI và copy phải sẵn sàng cho khách ngoài, không được giả định người dùng là người nhà.

Cơ chế khó sao chép: vận hành trực tiếp trên dữ liệu shop đang có sẵn (Drive "Ảnh AI" + Sheet "Hàng thiết kế 2026") theo quy ước đặt tên file thực tế, với hàng rào nghiệp vụ cứng — kiểm tồn kho 2 lần trước AI và trước khi đăng, whitelist trường được vào caption, khoá chống đăng trùng, không lỗi nào bị nuốt im lặng.

## Operating Context

- Dữ liệu nguồn: Google Drive thư mục "Ảnh AI" (file đặt tên `MÃ-Màu (số).jpg/mp4`, ~5.500 file) + Google Sheet "Hàng thiết kế 2026" tab "Mẫu 2026". Danh sách màu lấy từ tên file thật, không nhập tay.
- Luồng bất biến: tra Sheet → kiểm tồn kho → gom media → gọi AI → validator → **người duyệt caption** → đăng giãn cách. Người vận hành luôn duyệt trước khi đăng.
- Chạy theo lô: mã hết hàng bị bỏ qua không dừng lô; cuối phiên có bảng tổng kết mã nào lên kênh nào, mã nào bị chặn và vì sao.
- Cảnh báo tồn thấp ("Tồn thấp 3c — không nhận sx 1c") là thông tin nội bộ hiển thị trên UI cho người vận hành, tuyệt đối không vào caption.
- Đa tenant: cookie chỉ là selector, membership trong DB là authorization; mọi bảng có `tenant_id` (docs/09, docs/10).

## Capabilities and Constraints

- Stack đã chốt (CLAUDE.md): Next.js App Router + TypeScript, PostgreSQL + Drizzle, BullMQ + Redis, worker riêng, Tailwind + shadcn/ui, AI Gateway (hiện một provider OpenAI), Docker Compose 1 VPS.
- Design system hiện hữu: **Astryx v0.4.0** (`@astryxdesign/core` + `theme-neutral`) — 156 component, token-first, cấm div/raw CSS. UI hiện có: shell, compose wizard, duyệt caption từng kênh, quản lý kênh, members, sync, platform admin (src/ui/components/).
- Kiến trúc bắt buộc: clean architecture một chiều `app/worker/ui → composition → adapters → core` (docs/07), cưỡng chế bằng ESLint + dependency-cruiser.
- Thuật ngữ cố định: mã sản phẩm, màu, số đuôi ảnh, tồn kho, caption, kênh, lô (batch), post_job (1 bài × 1 kênh).
- Quyết định nghiệp vụ đang treo: C1/C2/C5, C3/C4, D1, D2, E1, E3 — không tự quyết, đánh dấu `// PENDING(<mã>)`.

## Brand Commitments

"MYSP" là **tên tạm**, không phải ràng buộc nhận diện — sẽ đổi khi thương mại hoá. Chưa có logo, bảng màu hay guideline thương hiệu ràng buộc. Giọng điệu sản phẩm hiện hành: UI tiếng Việt, thông điệp cho người vận hành rõ ràng, không đổ lỗi, trả lời được "vì sao".

## Evidence on Hand

- `sample-data/`: listing 5.500 file Drive thật, snapshot Sheet, 5 mã sản phẩm mẫu.
- `docs/05-data-profile.md`: hiện trạng dữ liệu thật đã khảo sát.
- Drive + Sheet production thật đang hoạt động (link trong brief).
- Chưa có: testimonial, khách hàng ngoài, số liệu hiệu quả — không được bịa khi làm trang giới thiệu/marketing.

## Product Principles

1. **Không đăng sai còn hơn đăng nhanh** — mọi hàng rào (tồn kho, whitelist, khoá trùng) đứng trước tốc độ; lỗi phải hiện ra, không bao giờ im lặng.
2. **Người vận hành là người duyệt cuối** — AI đề xuất, người quyết; UI phải làm việc duyệt theo lô nhanh và khó làm sai.
3. **Trả lời được "vì sao bài này không lên"** — mọi trạng thái chặn/lỗi đều truy được nguyên nhân ngay trên UI, không cần developer.
4. **Sẵn sàng cho khách ngoài** — copy, onboarding, phân quyền viết cho shop bất kỳ, không giả định người nhà.
5. **Dữ liệu của shop là nguồn chân lý** — công cụ bám theo Drive/Sheet đang có, không bắt shop đổi quy trình nhập liệu.

## Accessibility & Inclusion

Chưa có yêu cầu chuẩn cụ thể từ người dùng. Mặc định thực tế: người dùng không rành kỹ thuật, UI tiếng Việt, ưu tiên đọc rõ trên desktop; giữ nền a11y của Astryx (focus, contrast, semantics) làm sàn.
