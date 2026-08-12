# Đối chiếu Brief ↔ Plan — kiểm tra độ phủ

**Ngày:** 12/08/2026 · So brief `Yeu-cau-tinh-nang-Dang-bai-tu-dong (1).md` với docs 01–05.
**Ký hiệu:** ✅ phủ đủ trong Phase 1 · 🕑 phủ đủ nhưng nằm Phase 2/3 (theo quyết định v2) · ⚠️ có lỗ hổng, đã vá trong lần đối chiếu này · ❓ chờ quyết định (đã có câu hỏi truy vết)

---

## 1. Sáu việc cốt lõi (brief mục 1)

| # | Việc cốt lõi | Trạng thái | Nằm ở đâu |
|---|---|---|---|
| 1 | Lấy ảnh/video từ Drive theo mã | ✅ | E2 (P1) |
| 1b | ...hoặc người dùng tự tải lên | 🕑 P3 | E9 — **brief coi là cốt lõi, plan đẩy P3 → cần stakeholder ký nhận** |
| 2 | Đăng bài ảnh nhiều tấm | ✅ | E5.2 (P1) |
| 2b | Đăng video / Reels | 🕑 P2 | E5.3, E5.4 — khảo sát cho thấy chỉ có 19 video trên Drive → rủi ro thấp khi lùi |
| 3 | Đăng FB + TikTok một lần bấm | 🕑 P2 (TikTok) | E6 — quyết định v2 của PM, audit theo dõi song song |
| 4 | AI viết content từ Sheet + ảnh | ✅ | E4 (P1) |
| 5 | Mỗi kênh một caption riêng | ✅ | E4.5 + E7.2 (P1) |
| 6 | Đăng ngay | ✅ | E7 (P1) |
| 6b | Hẹn lịch | 🕑 P2 | E8 |

## 2. Nguồn dữ liệu (brief mục 2)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Quy ước tên file, parse mã/màu/số/đuôi | ✅ | E2.2 + doc 05 (thực tế: 28,2% sai chuẩn → parser 2 tầng, doc 02) |
| Sai chuẩn báo lỗi rõ, không im lặng | ✅ | E2.7 màn hình file lỗi (không chặn cứng cả luồng — điều chỉnh có chủ đích so với brief, lý do ở doc 05 mục 1.2) |
| Chỉ .jpg/.mp4 | ⚠️ đã vá | Thực tế png 50% + jpeg + mov + 606 file không đuôi → doc 02 đã mở rộng danh sách đuôi |
| Đọc đúng 7 cột Sheet, tra theo Mã | ✅ | E2.3 (đọc theo tên cột) — tên cột thật đã xác minh (doc 05 mục 2.1) |
| Danh sách trắng trường vào caption | ✅ | E4.3 (P1) — càng quan trọng vì Sheet thật có 4 cột giá |

## 3. Quy tắc tồn kho (brief mục 3)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Chặn khi Tồn=0 hoặc Lưu ý="HẾT HÀNG"; hết hàng luôn thắng | ✅ | E3.1 bảng quyết định (doc 04 ngày 6–7 có bảng mẫu) |
| Tồn 1–3: đăng + cảnh báo nội bộ, không vào caption | ✅ | E3.1 + E10.4 + validator E4.4 |
| Chạy trước khi gọi AI | ✅ | Doc 02 mục 5.1 thứ tự bắt buộc + test khoá thứ tự |
| Chạy lô: mã lỗi bỏ qua, cuối phiên có bảng tổng kết | 🕑 P2 | E7.5 (kết quả từng kênh P1) + E10.5 (UI chạy lô — P2) |
| Ô Tồn trống (5 dòng thật) | ❓ đề xuất chặn | B8 đã đóng phần dữ liệu; rule ô trống chờ xác nhận |
| Giá trị Lưu ý mới "Không cần cọc" (36 dòng) | ❓ | Ngoài brief — câu hỏi mới #4 doc 05 |

## 4. Chọn màu & chọn ảnh (brief mục 4)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Ô chọn màu, lọc theo màu trong tên file, chọn nhiều màu | ✅ | E3.2 + bảng chuẩn hoá màu (bổ sung v2 sau khảo sát) |
| Danh sách màu từ tên file thật, không nhập tay | ✅ | E3.2 — lưu ý thực tế cần chuẩn hoá dấu/hoa thường trước khi hiển thị |
| Mỗi màu một bài riêng, trừ khi gộp | ❓ C3, C4 | E3.2 — hành vi gộp chưa định nghĩa trong brief |
| 3 chế độ nhập số đuôi + quy tắc số lượng | ✅ | E3.3 — 2 cách hiểu mơ hồ đã thành câu C1, C2 |
| Số đuôi không tồn tại → báo lỗi rõ | ❓ C5 | E3.3 — chặn cả bài hay đăng phần còn lại: chờ chốt |

## 5. Định dạng bài đăng (brief mục 5)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Tự nhận diện ảnh/video theo đuôi | ✅ | E2.2 (mở rộng: xử lý cả file không đuôi) |
| Mã có cả ảnh + video: cho chọn | 🕑 P2 | E10.1 wizard — phần video P2 |
| "Ảnh lên Facebook, video lên TikTok" | ⚠️ đã vá | Trước không có item nào nêu rõ — đã thêm ghi chú vào E10.1 (P2, cùng TikTok) |
| Kiểm tra thông số video TRƯỚC khi upload | 🕑 P2 | ffprobe, doc 02 mục 5.4 + E5.3 |
| Video lớn upload từng phần + tiến độ | 🕑 P2 | Doc 02 mục 5.4 |

## 6. Đăng đa nền tảng (brief mục 6)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Chọn nhiều Page/tài khoản, tick, gom nhóm nền tảng | ✅ (FB) / 🕑 (TikTok) | E10.3 |
| Nhóm kênh đặt sẵn | ✅ | E7.6 + E10.3 |
| Đăng giãn cách 1–3 phút, chỉnh được | ❓ E1 (câu hỏi) | E7.3 — giãn cách giữa kênh hay giữa bài: chờ chốt |
| Kết quả theo từng kênh + link bài | ✅ | E7.5 |
| Một kênh lỗi không dừng kênh khác | ✅ | Thiết kế `post_job` = 1 bài × 1 kênh (doc 02 mục 4) — yêu cầu này thành hiển nhiên |

## 7. AI sinh content (brief mục 7)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| 2 nguồn: Sheet (chính) + ảnh (phụ) | ✅ | E4.1 gửi kèm ảnh |
| **Mâu thuẫn thì tin Sheet; không suy đoán thông số từ ảnh** | ⚠️ đã vá | Trước chỉ nằm ngầm — đã ghi thành yêu cầu bắt buộc của prompt template E4.2 |
| Video: AI dùng Sheet + ảnh cùng mã, không phân tích video | 🕑 P2 | Ghi chú E4.2 |
| Mỗi kênh caption khác nhau hoàn toàn | ❓ D1 (ngưỡng đo) | E4.5 — cách đo chờ chốt |
| Prompt template theo nền tảng, sửa không cần code | ✅ | E4.2 + E10.7 |
| Dòng đầu: `Tên – TIÊU ĐỀ CẢM XÚC VIẾT HOA` | ⚠️ đã vá | Validator E4.4 trước chỉ check "tên đứng đầu" — đã thêm check định dạng dòng đầu (có dấu –, phần tiêu đề viết hoa) |
| Kết thúc 3–5 hashtag | ✅ | E4.4 |
| Không giá trong caption | ❓ D2 (định nghĩa mẫu giá) | E4.4 |
| Tên nhất quán, truyền như biến bắt buộc, sai thì viết lại | ✅ | E4.2 + E4.4 + E4.6 — lưu ý thực tế: tên file có thể chứa tên mẫu KHÁC (ca MG0SV6055-PIERA, doc 05) → validator không được tin tên file |
| Xem trước từng kênh, sửa tay, viết lại, duyệt | ✅ | E10.2 |
| Tự động đăng: toggle, mặc định TẮT | ✅ | E10.2 |

## 8. Hai chế độ lấy file (brief mục 8)

| Yêu cầu | Trạng thái | Nằm ở đâu |
|---|---|---|
| Chế độ A (Drive theo mã) | ✅ | E2 + E3 + wizard E10.1 |
| Chế độ B (tự tải, kéo-thả, sắp thứ tự) | 🕑 P3 | E9 — brief coi là cốt lõi → cần ký nhận phasing |
| Hai chế độ dùng chung tồn kho/AI/đăng | ✅ thiết kế | E9.3 rẻ nhờ pipeline chung (doc 02) |

## 9. Hẹn lịch (brief mục 9) — 🕑 toàn bộ P2

| Yêu cầu | Nằm ở đâu |
|---|---|
| Đặt lịch từng bài + hàng loạt, giờ riêng từng kênh | E8.1 |
| Màn hình quản lý: xem, sửa, đổi giờ, hủy | E8.4 |
| Kiểm tra lại tồn ngay trước khi đăng | E8.2 — **riêng phần "đăng ngay" cũng kiểm tra lần 2: đã vá, chuyển vào E7.4 (P1)** |
| Hết hàng trong đêm → tự hủy + báo | E8.3 (kênh báo: câu E3) |
| Đến giờ đăng lỗi → báo, không im lặng | E8.5 |

## 10. Mười lăm tiêu chí nghiệm thu (brief mục 10)

| # | Tiêu chí | Phase | Ghi chú |
|---|---|---|---|
| 1 | Nhập mã → bài lên đủ kênh đã chọn | P1 (FB) / P2 (TikTok) | |
| 2 | Đăng được cả ảnh và video | P2 | video |
| 3 | Chọn màu lọc đúng | P1 | + chuẩn hoá màu |
| 4 | Số đuôi đúng ảnh, đúng thứ tự | P1 | chờ C1/C2/C5 |
| 5 | Mỗi kênh caption riêng, không trùng | P1 | chờ ngưỡng D1 |
| 6 | Hết hàng bị chặn mọi kênh | P1 | |
| 7 | Tồn ≤3 vẫn đăng + cảnh báo nội bộ | P1 | |
| 8 | Không giá/tồn/ghi chú sx trong caption | P1 | chờ D2 |
| 9 | Tên đúng từ Sheet, nhất quán | P1 | |
| 10 | 3–5 hashtag cuối bài | P1 | |
| 11 | Video sai thông số báo trước khi upload | P2 | |
| 12 | Tự tải lên đăng được, sắp thứ tự được | P3 | |
| 13 | Hẹn lịch đúng giờ, sửa/hủy, recheck tồn | P2 | |
| 14 | Chạy lô: lỗi bỏ qua, có tổng kết | P2 | |
| 15 | (mục 1 brief) một bấm lên cả FB+TikTok | P2 | quyết định v2 |

**Đếm: 10/15 tiêu chí nằm trong Phase 1; 4 tiêu chí Phase 2; 1 tiêu chí Phase 3.**

---

## Kết luận đối chiếu

1. **Không sót yêu cầu nào** — mọi mục của brief đều truy vết được về một epic/hạng mục hoặc một câu hỏi mở có mã số.
2. **4 lỗ hổng nhỏ phát hiện trong lần đối chiếu này — đã vá vào docs 02/03:**
   - Validator thiếu check định dạng dòng đầu `Tên – TIÊU ĐỀ VIẾT HOA` → thêm vào E4.4.
   - Nguyên tắc "mâu thuẫn tin Sheet, không suy đoán thông số từ ảnh" chưa thành yêu cầu cụ thể → ghi vào E4.2.
   - Kiểm tra tồn lần 2 cho **đăng ngay** nằm nhầm chỗ ở E8 (P2) → chuyển thành phần của E7.4 (P1).
   - Tuỳ chọn "ảnh lên FB, video lên TikTok" không có item → ghi chú vào E10.1 (P2).
3. **Các chỗ lệch brief là CÓ CHỦ ĐÍCH và có hồ sơ:** TikTok/video/hẹn lịch/chế độ B lùi phase (quyết định v2 + khảo sát 19 video); "sai chuẩn báo lỗi" nới thành "liệt kê lỗi, không chặn luồng" (28,2% file sai — doc 05). Khi chốt `scope-baseline-v1`, đưa bảng mục 10 ở trên cho stakeholder ký nhận phần phasing.
4. **13 điểm chờ quyết định** đều đã có mã truy vết (C1–C5, D1–D2, E1, E3, B-mới #1–9...) — không có mơ hồ nào trôi tự do.
