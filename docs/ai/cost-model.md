# Cost Model — Proposal (chờ duyệt)

## 1. Đơn vị chi phí: một generation, một bài, một bài THÀNH CÔNG

```
cost/generation  = Σ attempt (input×giá_in + output×giá_out + cached×giá_cache)
cost/bài         = Σ generation của post_job (các kênh × các lần viết lại)
cost/bài published = tổng chi AI trong kỳ ÷ số bài published trong kỳ   ← KPI chính
```

`cost/bài published` mới là số thật — nó gánh cả chi phí của bài fail validation, bài bị người vận hành huỷ, escalation. Chỉ nhìn cost/generation sẽ ảo.

## 2. Ước lượng khối lượng (giả định — sửa bằng số thật sau 2 tuần vận hành)

| Tham số | Giả định MVP |
|---|---|
| Bài/ngày | 30 mã × 2 kênh FB = 60 generation/ngày |
| Token/generation | ~1.5K in (context + prompt) + ~1 ảnh vision + ~400 out |
| Tỉ lệ escalation | 10% lên mid, 2% lên top (giả thuyết — đo lại) |
| Viết lại theo yêu cầu người dùng | 20% bài có 1 lần "viết lại" |

Ước tính thô/tháng (30 ngày, quyết định 12/08: primary Gemini 3.5 Flash-Lite $0.30/$2.50, escalation Gemini 3.6 Flash/3.1 Pro): 60 gen/ngày × ~1.5K in + ảnh + 400 out ≈ **dưới 10 USD/tháng** ở khối lượng MVP — chi phí AI không phải rủi ro Phase 1, nhưng cấu trúc routing phải đúng từ đầu vì SaaS nhiều tenant nhân số này lên trăm lần. **Bắt buộc paid tier** (free tier dùng data để training — provider-strategy.md mục 3); paid tier cùng giá token này.

⚠️ Con số trên là khung suy nghĩ, không phải cam kết — điền lại toàn bộ bằng số đo từ `ai_generation` sau tuần đầu chạy thật (bảng giá verify lại theo trang chính thức tại thời điểm chạy).

## 3. Cơ chế kiểm soát (khớp E4.8 hiện có + mở rộng)

| Cơ chế | Mức | Hành vi khi chạm |
|---|---|---|
| Trần/generation | ước trước khi gọi (token dự kiến × giá); escalation không được vượt | Dừng escalation, chuyển cần-người-xử-lý |
| Hạn mức/ngày/tenant | config theo tenant (`tenant_integration`) | Chặn generation mới, cảnh báo vận hành; KHÔNG chặn bài đã duyệt đang đăng |
| Cảnh báo bất thường | cost/ngày > 2× trung bình 7 ngày | Thông báo kênh cảnh báo (câu E3) |
| Prompt caching | phần system + guideline cố định đặt đầu prompt, bật cache của provider | Giảm chi phí input lặp (GPT-5.4 mini cached $0.075/M — rẻ 90%) |

## 4. Đòn bẩy chi phí theo thứ tự hiệu quả

1. **Routing đúng tier** (đã là kiến trúc) — chênh cheap↔top là ~7–30× mỗi token.
2. **1 ảnh vision/generation** (nguyên tắc #6) — ảnh là phần token đắt nhất của request; resize ảnh bìa xuống chuẩn vision (~1024px cạnh dài) trước khi gửi.
3. **Prompt caching** — system prompt + brand guideline ổn định, chỉ phần product data đổi.
4. **Không gọi AI cho việc thuật toán làm được** — so trùng caption giữa kênh dùng thuật toán chuỗi trước (D1), chỉ cân nhắc LLM khi có bằng chứng cần.
5. Tồn kho chặn TRƯỚC khi gọi AI (đã là rule bất biến) — với 75% mã hết hàng trong Sheet hiện tại, riêng rule này tiết kiệm phần lớn lượt gọi vô ích.

## 5. Trách nhiệm

Số liệu: bảng `ai_generation` (prompt-versioning.md mục 2) — không hệ thống billing riêng ở MVP. Review chi phí: mục cố định trong weekly review của PM, cạnh trạng thái audit TikTok.
