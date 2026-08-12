# WBS & Estimate — Công cụ đăng bài tự động

> **Cập nhật v2 (12/08/2026)** — 3 quyết định mới của PM:
> 1. **TikTok không nằm trong phase này.** Code TikTok (E6) chuyển hẳn sang Phase 2. App TikTok & Facebook **đã có sẵn** — thủ tục audit/duyệt tiếp tục chạy song song; việc còn lại của E0 là **verify trạng thái thật** trên dashboard (đã pass review chưa, quyền nào đã cấp).
> 2. **SaaS-ready mức data model:** mọi bảng có `tenant_id`, query scope theo tenant, credential/cấu hình lưu theo tenant. E1.3 +2 MD.
> 3. **Khảo sát dữ liệu do PM + AI agent tự làm** qua Google Drive MCP (không chờ BA) — kết quả ở `05-data-profile.md`.

**Đơn vị:** man-day (MD) = 1 người làm 1 ngày.
**Cột "Chuẩn"** = ước lượng cho một dev fullstack có kinh nghiệm, làm thủ công.
**Cột "Có AI"** = ước lượng thực tế cho team hiện tại (1 người + Claude agent). Hệ số giảm không đồng đều: code lặp giảm mạnh, tích hợp API bên thứ ba và gỡ lỗi giảm ít, phần chờ duyệt không giảm chút nào.

Estimate này giả định các câu 🔴 trong `01-cau-hoi-lam-ro-cho-BA.md` đã có đáp án. Nếu chưa, xem mục 6 về độ tin cậy.

---

## 1. Bảng WBS

### E0 — Khởi động & quyền truy cập nền tảng

*(v2: app FB & TikTok đã có sẵn — E0.1–E0.3 đổi tính chất từ "tạo & nộp" thành "verify trạng thái + bổ sung phần thiếu". Estimate giữ nguyên làm trần; sau khi verify có thể giảm.)*

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E0.1 | Verify Facebook App: chế độ Live?, Business Verification xong chưa; bổ sung nếu thiếu | 1 | 1 | Không rút ngắn được |
| E0.2 | Verify App Review 4 quyền Page đã pass chưa; nộp bổ sung nếu thiếu (kèm screencast) | 1.5 | 1.5 | Làm lại nếu bị từ chối |
| E0.3 | Verify TikTok App: Content Posting API + Direct Post + trạng thái **audit** | 1.5 | 1.5 | **Phase 2** — theo dõi song song từ bây giờ |
| E0.4 | Mua tên miền, xác minh tên miền với TikTok, dựng đường phục vụ media | 1 | 0.5 | **Phase 2** — bắt buộc để đăng ảnh TikTok |
| E0.5 | Tạo Google Cloud project, Service Account, chia sẻ Drive + Sheet | 0.5 | 0.5 | Cần IT phối hợp |
| | **Cộng phase 1** (E0.1+E0.2+E0.5) | **3** | **3** | **+ thời gian chờ nếu review chưa pass** |

> ⚠️ Verify E0.2 (Meta) và E0.3 (TikTok audit) ngay **tuần đầu** — nếu hoá ra chưa pass thì thời gian chờ duyệt vẫn là critical path như bản v1.

### E1 — Nền tảng dự án

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E1.1 | Khởi tạo repo, TypeScript, lint, format, cấu trúc thư mục | 1 | 0.5 | |
| E1.2 | Docker Compose (web + worker + postgres + **redis** + reverse proxy) | 1.5 | 1 | Redis: AOF persistence + nằm trong backup |
| E1.3 | Schema DB + migration, **tenant_id mọi bảng + query scope theo tenant + bảng `tenant_integration`** (quyết định SaaS v2) | 4 | 3 | Còn chặn bởi câu B10 (F5 đã chốt) |
| E1.4 | Đăng nhập Google, giới hạn theo tên miền, session | 1.5 | 1 | |
| E1.5 | Dựng BullMQ + Redis, worker chạy được, job mẫu | 1 | 0.5 | Đổi từ pg-boss (quyết định 12/08) |
| E1.6 | Log có cấu trúc, xử lý lỗi tập trung | 1 | 0.5 | |
| | **Cộng** | **10** | **6.5** | |

### E2 — Tích hợp Google Drive & Sheet

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E2.1 | Client Drive: liệt kê file, phân trang, tải file | 1.5 | 1 | |
| E2.2 | Parser tên file `MÃ-Màu (số).ext` + xử lý ca sai chuẩn | 2 | 1.5 | Nhiều edge case, cần dữ liệu thật |
| E2.3 | Client Sheet: đọc tab "Mẫu 2026", ánh xạ theo **tên cột** | 1.5 | 1 | |
| E2.4 | Tầng kiểm tra & chuẩn hoá dữ liệu (ô trống, chữ trong cột số, khoảng trắng) | 2 | 1.5 | Rủi ro R4 |
| E2.5 | Job đồng bộ định kỳ + bảng `product_snapshot`, `media_asset` | 2 | 1 | |
| E2.6 | Phát hiện đổi cấu trúc Sheet và cảnh báo | 1 | 0.5 | |
| E2.7 | Màn hình quản trị: xem trạng thái đồng bộ, danh sách file lỗi chuẩn | 1.5 | 0.5 | Cần thật, vận hành sẽ dùng hằng ngày |
| | **Cộng** | **11.5** | **7** | |

### E3 — Tồn kho, chọn màu, chọn ảnh

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E3.1 | Bảng quyết định tồn kho (hết / thấp / bình thường, thứ tự ưu tiên) | 1.5 | 1 | Chặn bởi B8, B9, B10 |
| E3.2 | Lọc màu từ tên file, hỗ trợ chọn nhiều màu, tuỳ chọn gộp bài | 2 | 1.5 | Chặn bởi C3, C4 |
| E3.3 | Chọn ảnh theo số đuôi (3 chế độ ở brief mục 4.2) | 2.5 | 2 | **Nhiều mơ hồ nhất** — C1, C2, C5 |
| E3.4 | Bộ test cho E3.1–E3.3 phủ hết edge case | 2 | 1 | Bắt buộc — đây là lõi nghiệp vụ |
| | **Cộng** | **8** | **5.5** | |

### E4 — AI sinh caption

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E4.1 | Client Anthropic, gửi kèm ảnh, xử lý lỗi và thử lại | 1.5 | 1 | |
| E4.2 | Hệ thống prompt template theo nền tảng, có phiên bản, sửa không cần deploy. Template bắt buộc chứa: nguyên tắc "ảnh mâu thuẫn Sheet thì tin Sheet, không suy đoán thông số từ ảnh" (brief 7.1) | 2 | 1.5 | Brief mục 7.1, 7.2 |
| E4.3 | Danh sách trắng trường dữ liệu (chặn Tồn/Lưu ý lọt vào prompt) | 1 | 0.5 | Brief mục 2.2 — bắt buộc |
| E4.4 | Validator: tên sản phẩm, **định dạng dòng đầu `Tên – TIÊU ĐỀ VIẾT HOA`**, giá tiền, hashtag, rò rỉ dữ liệu nội bộ | 2.5 | 1.5 | Chặn bởi D1, D2. Không tin tên trong tên file (ca MG0SV6055-PIERA, doc 05) |
| E4.5 | Kiểm tra trùng lặp caption giữa các kênh | 1.5 | 1 | Chặn bởi D1 (cần ngưỡng đo) |
| E4.6 | Vòng viết lại có giới hạn + trạng thái cần người xử lý | 1 | 0.5 | |
| E4.7 | Tinh chỉnh prompt trên dữ liệu thật cho tới khi shop hài lòng | 3 | 2.5 | **Ước lượng lỏng nhất** — phụ thuộc D8. Có thể gấp đôi nếu không có caption mẫu. |
| E4.8 | Theo dõi chi phí và hạn mức theo ngày | 1 | 0.5 | |
| E4.9 | Evaluation dataset + benchmark đợt 1 (docs/ai/evaluation.md) | 3 | 2 | Mới — ADR-001; chặn bởi expected_content từ shop (D8) |
| E4.10 | AI Gateway + Model Registry (YAML+DB+Redis cache) + bảng `ai_generation` + structured output | 4.5 | 3.5 | Mới — ADR-001; adapter google + openai |
| | **Cộng** | **21** | **14.5** | |

### E5 — Adapter Facebook

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E5.1 | OAuth, lấy Page token dài hạn, làm mới, quản lý nhiều Page | 2 | 1.5 | |
| E5.2 | Đăng album nhiều ảnh | 1.5 | 1 | |
| E5.3 | Đăng video | 1.5 | 1 | |
| E5.4 | Đăng Reels (luồng upload riêng) | 2 | 1.5 | Cần quyền riêng |
| E5.5 | Ánh xạ lỗi từ Graph API sang thông báo tiếng Việt dễ hiểu | 1.5 | 1 | Quan trọng cho vận hành |
| | **Cộng** | **8.5** | **6** | |

### E6 — Adapter TikTok — **toàn bộ epic thuộc Phase 2** (quyết định v2)

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E6.1 | OAuth, làm mới token, quản lý nhiều tài khoản | 2 | 1.5 | |
| E6.2 | Đăng video: khởi tạo, upload theo phần, hỏi trạng thái | 3 | 2.5 | Phần khó nhất của cả dự án |
| E6.3 | Đăng ảnh carousel qua URL trên tên miền đã xác minh | 2.5 | 2 | Phụ thuộc E0.4 |
| E6.4 | Xử lý và hiển thị rõ trạng thái riêng tư khi chưa qua audit | 1 | 0.5 | Rủi ro R1 — phải nói rõ trên UI |
| E6.5 | Ánh xạ lỗi, xử lý giới hạn tần suất | 1.5 | 1 | |
| | **Cộng** | **10** | **7.5** | |

### E7 — Điều phối đăng đa kênh

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E7.1 | Máy trạng thái `post_job` + chuyển trạng thái | 2 | 1 | |
| E7.2 | Fan-out một bài ra nhiều kênh, mỗi kênh một job độc lập | 1.5 | 1 | |
| E7.3 | Đăng giãn cách, khoảng cách cấu hình được | 1 | 0.5 | Chặn bởi E1 (câu hỏi) |
| E7.4 | Thử lại có giới hạn + khoá chống đăng trùng + **kiểm tra tồn lần 2 ngay trước khi gọi API đăng (áp dụng cả đăng ngay — brief mục 9)** | 2 | 1.5 | Rủi ro R7 — không được làm ẩu. Recheck tồn chuyển từ E8.2 về đây để Phase 1 có đủ |
| E7.5 | Kết quả theo từng kênh + bảng tổng kết lô | 2 | 1 | Brief mục 3, mục 6 |
| E7.6 | Quản lý nhóm kênh đặt sẵn | 1 | 0.5 | |
| | **Cộng** | **9.5** | **5.5** | |

### E8 — Hẹn lịch

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E8.1 | Đặt lịch từng bài và hàng loạt, hẹn giờ riêng theo kênh | 2 | 1.5 | |
| E8.2 | Scheduler + kiểm tra tồn kho lần hai trước khi đăng | 2 | 1.5 | Yêu cầu cốt lõi ở brief mục 9 |
| E8.3 | Tự huỷ khi hết hàng + gửi cảnh báo | 1.5 | 1 | Chặn bởi E3 (kênh thông báo) |
| E8.4 | Màn hình quản lý bài đã hẹn: xem, sửa nội dung, đổi giờ, huỷ | 3 | 2 | |
| E8.5 | Cảnh báo khi đăng lỗi lúc đến giờ | 1 | 0.5 | |
| | **Cộng** | **9.5** | **6.5** | |

### E9 — Chế độ B: tự tải file lên

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E9.1 | Kéo-thả tải lên, lưu tạm, kiểm tra kiểu và dung lượng | 2 | 1.5 | |
| E9.2 | Kéo-thả sắp xếp lại thứ tự, chỉ định ảnh bìa | 1.5 | 1 | Trên mobile khó hơn nhiều — phụ thuộc F3 |
| E9.3 | Dùng chung toàn bộ luồng tồn kho / AI / đăng bài | 1 | 0.5 | Nếu E7 thiết kế đúng thì rẻ |
| E9.4 | Dọn file tạm | 0.5 | 0.5 | |
| | **Cộng** | **5** | **3.5** | |

### E10 — Giao diện chính

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E10.1 | Wizard soạn bài (nhập mã → chọn màu → chọn ảnh → chọn định dạng → chọn kênh) | 4 | 2.5 | Phase 2 bổ sung: tuỳ chọn "ảnh lên Facebook, video lên TikTok" (brief mục 5) |
| E10.2 | Xem trước và duyệt caption từng kênh, sửa tay, nút viết lại | 3 | 2 | Brief mục 7.6 |
| E10.3 | Chọn kênh dạng tick, gom nhóm theo nền tảng, chọn nhanh cả nhóm | 1.5 | 1 | |
| E10.4 | Hiển thị cảnh báo tồn kho (chặn / tồn thấp) đúng chỗ, không lẫn vào caption | 1 | 0.5 | |
| E10.5 | Chạy hàng loạt: nhập nhiều mã, theo dõi tiến độ, bảng tổng kết | 3 | 2 | |
| E10.6 | Quản lý kênh, nhóm kênh, trạng thái token | 2 | 1 | |
| E10.7 | Màn hình sửa prompt template | 1.5 | 1 | |
| E10.8 | Trạng thái tải/rỗng/lỗi, thông báo phản hồi, khả năng truy cập cơ bản | 2 | 1 | |
| | **Cộng** | **18** | **11** | |

### E11 — Vận hành & giám sát

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E11.1 | Màn hình nhật ký job, xem lỗi, chạy lại thủ công | 2 | 1 | |
| E11.2 | Kênh cảnh báo (Zalo/Slack/email) cho job lỗi và token sắp hết hạn | 1.5 | 1 | Chặn bởi E3 |
| E11.3 | Job tự làm mới token | 1 | 0.5 | |
| E11.4 | Sao lưu DB theo lịch + thử khôi phục một lần | 1 | 1 | Thử khôi phục không được bỏ |
| | **Cộng** | **5.5** | **3.5** | |

### E12 — Kiểm thử & nghiệm thu

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E12.1 | Unit test cho lõi nghiệp vụ (tồn kho, chọn ảnh, validator) | 3 | 1.5 | |
| E12.2 | Integration test cho adapter (dùng bản giả lập API) | 2.5 | 1.5 | |
| E12.3 | Chạy thật đầu-cuối trên tài khoản test, gồm cả ca lỗi | 3 | 2.5 | Không rút ngắn được — phải chạy thật |
| E12.4 | Kịch bản UAT bám sát 15 tiêu chí ở brief mục 10 | 2 | 1 | |
| E12.5 | Sửa lỗi phát sinh từ UAT | 4 | 3 | Dự phòng, thường bị ước lượng thiếu |
| | **Cộng** | **14.5** | **9.5** | |

### E13 — Bàn giao

| Mã | Hạng mục | Chuẩn | Có AI | Ghi chú |
|---|---|---|---|---|
| E13.1 | Triển khai production, cấu hình tên miền, HTTPS | 1.5 | 1 | |
| E13.2 | Tài liệu vận hành (xử lý sự cố thường gặp, cách gia hạn token) | 1.5 | 1 | |
| E13.3 | Đào tạo người dùng + quay video hướng dẫn | 1.5 | 1.5 | |
| | **Cộng** | **4.5** | **3.5** | |

---

## 2. Tổng hợp

| Epic | Chuẩn (MD) | Có AI (MD) | Phase |
|---|---:|---:|---|
| E0 Khởi động & quyền truy cập | 5.5 | 5.0 | 1 (E0.3, E0.4 → 2) |
| E1 Nền tảng (đã gồm +2 MD tenant/SaaS) | 10.0 | 6.5 | 1 |
| E2 Drive & Sheet | 11.5 | 7.0 | 1 |
| E3 Tồn kho & chọn ảnh | 8.0 | 5.5 | 1 |
| E4 AI caption (gồm ADR-001: gateway, registry, eval) | 21.0 | 14.5 | 1 |
| E5 Facebook | 8.5 | 6.0 | 1 (video → 2) |
| E6 TikTok | 10.0 | 7.5 | **2** |
| E7 Điều phối đa kênh | 9.5 | 5.5 | 1 (rút gọn) |
| E8 Hẹn lịch | 9.5 | 6.5 | 2 |
| E9 Chế độ B | 5.0 | 3.5 | 3 |
| E10 Giao diện | 18.0 | 11.0 | 1 (lõi) / 3 |
| E11 Vận hành | 5.5 | 3.5 | 3 |
| E12 Kiểm thử & UAT | 14.5 | 9.5 | rải theo phase |
| E13 Bàn giao | 4.5 | 3.5 | 3 |
| **Cộng toàn scope** | **141.0** | **95.0** | |
| Dự phòng rủi ro 20% | 28.0 | 19.0 | |
| **TỔNG toàn scope** | **~169 MD** | **~114 MD** | |

**Quy đổi lịch cho team hiện tại (1 người, ~4.5 ngày làm việc hiệu quả/tuần):**
→ **~23 tuần làm việc thuần**, tức **khoảng 5–6 tháng** nếu làm toàn bộ scope.

Con số này lớn hơn cảm giác ban đầu vì brief chứa 4 hệ thống con thực thụ: đồng bộ dữ liệu, sinh nội dung bằng AI, tích hợp hai nền tảng đăng bài, và hẹn lịch có kiểm tra lại điều kiện. Cách rút ngắn duy nhất là cắt scope, không phải làm nhanh hơn.

---

## 3. Phân phase — đề xuất

### Phase 1 — MVP Facebook, SaaS-ready (≈ 45 MD, ~10 tuần) ← **phase hiện tại (v2 + ADR-001)**

E0 (trừ mục TikTok) + E1 (gồm tenant) + E2 + E3 + E4 + E5 (trừ video) + E7 (rút gọn) + E10 (phần lõi) + E12 (rút gọn)

Làm được: nhập mã → chọn màu, chọn ảnh → kiểm tra tồn kho → AI viết caption riêng cho từng Page → duyệt → đăng ngay lên nhiều Facebook Page. Data model đã sẵn sàng multi-tenant.
Chưa có: TikTok, video, hẹn lịch, chế độ tự tải lên, chạy hàng loạt, UI đăng ký/mời user.

(≈45 MD = 40 của v2 + 5.5 MD từ ADR-001: AI gateway/registry/log 3.5 + evaluation 2.)

**Vì sao cắt như vậy:** lát cắt dọc nhỏ nhất vẫn tạo giá trị thật hằng ngày, không phụ thuộc audit TikTok, và không phải viết lại schema khi mở SaaS.

### Phase 2 — TikTok + video + hẹn lịch (≈ 32 MD, ~7 tuần)

E6 + E8 + E0.3/E0.4 (tên miền, verify audit) + phần video của E5 + E10.5

Điều kiện tiên quyết: TikTok audit đã đạt (hoặc đã chốt phương án dự phòng ở câu A6). App đã có sẵn — theo dõi trạng thái audit **hằng tuần ngay từ phase 1**.

### Phase 3 — Hoàn thiện (≈ 35 MD, ~8 tuần)

E9 (chế độ B) + E11 + E10 phần còn lại + E12 đầy đủ + E13

---

## 4. Đường găng

```
Tuần 0  ├─ Verify trạng thái Meta App Review (app đã có sẵn) ──┐
        ├─ Verify trạng thái TikTok audit (theo dõi song song) │ (chỉ chờ nếu chưa pass)
        └─ Khảo sát dữ liệu (PM+AI) + BA làm rõ requirements   ┘
Tuần 1  ├─ E1 Nền tảng (schema tenant-ready)
Tuần 2  ├─ E2 Drive/Sheet
Tuần 4  ├─ E3 + E4 (lõi nghiệp vụ)
Tuần 6  ├─ E5 Facebook ◀── cần Meta review pass tới đây (nếu chưa pass sẵn)
Tuần 8  ├─ Phase 1 lên production
        └─ (TikTok audit chỉ chặn Phase 2, không chặn phase này)
```

**Điểm chặn duy nhất của phase này:** trạng thái Meta App Review. App đã có sẵn nhưng "có app" ≠ "đã pass review với đủ 4 quyền Page" — verify tuần 0 là việc số một. Nếu hoá ra chưa pass, timeline quay về bản v1 (chờ 2–6 tuần, code trên Page test trong lúc chờ).

TikTok audit không còn chặn phase này, nhưng vẫn theo dõi hằng tuần để Phase 2 không có khoảng chết.

---

## 5. Vì sao "có AI" chỉ giảm ~33%, không phải một nửa

| Loại việc | Mức giảm | Vì sao |
|---|---:|---|
| Code lặp (CRUD, form, migration, component) | −50…60% | AI làm rất tốt |
| Test | −50% | Sinh test nhanh, nhưng vẫn phải đọc lại |
| Tích hợp API bên thứ ba | −20…25% | Tài liệu Meta/TikTok hay lệch thực tế; vẫn phải thử tay và đọc lỗi thật |
| Tinh chỉnh prompt AI | −15% | Bản chất là vòng lặp thử-và-đánh-giá với người thật |
| Gỡ lỗi tích hợp | −10…20% | Lỗi nằm ở chỗ ghép nối, cần chạy thật |
| Chờ duyệt, chạy thật đầu-cuối, đào tạo | 0% | Không giảm |

Đây là lý do estimate không chia đôi. Phần lớn khối lượng còn lại của dự án này nằm ở tích hợp và xác minh thực tế — đúng những chỗ AI hỗ trợ ít nhất.

---

## 6. Độ tin cậy của estimate

**Mức tin cậy hiện tại: trung bình (±25%)** — nâng từ ±40% sau khảo sát dữ liệu 12/08/2026.

Đã đóng: toàn bộ nhóm B trừ B5/B6/B12/B13 (xem `05-data-profile.md`), B10 (tồn theo mã — không phải đổi schema), F5 (SaaS). Khảo sát cũng xác nhận E2.2 (parser) đúng là hạng mục nhiều edge case như đã dự trù — 28,2% file sai chuẩn, cần thêm **+1,5 MD vào E2** cho bảng chuẩn hoá màu + khử trùng lặp (chưa cộng vào bảng, cộng khi chốt baseline).

Các câu còn ảnh hưởng estimate:

| Câu | Nếu đáp án bất lợi | Ảnh hưởng |
|---|---|---|
| A2/A3 — Meta review đã pass chưa | Chưa pass | Phase 1 production lùi 2–6 tuần chờ duyệt |
| Thư mục "Hàng Thiết Kế" (mới) | Chứa ảnh 236 mã, cấu trúc khác | E2 tăng nếu phải đọc đệ quy nhiều tầng |
| Chỉ 20 mã đăng được ngay (mới) | Không có kế hoạch bổ sung dữ liệu | Không tăng MD nhưng **giảm giá trị bàn giao** — cần stakeholder cam kết làm sạch dữ liệu song song |
| A5 — TikTok audit (theo dõi cho Phase 2) | Trượt audit | E6 (10 MD) mất giá trị, thiết kế lại luồng dự phòng |
| F3 — bắt buộc mobile | Phải dùng tốt trên điện thoại | E9 + E10 tăng ~8 MD |

**Đề xuất:** chốt bộ câu hỏi 🔴 trước, rồi làm lại estimate. Khi đó độ tin cậy đạt được ±15%.

Cho tới lúc đó, **con số nên báo với stakeholder là khoảng, không phải một số cụ thể**: *"Phase 1 khoảng 8–11 tuần, toàn bộ scope khoảng 5–7 tháng, với điều kiện quyền API được duyệt đúng hạn."*
