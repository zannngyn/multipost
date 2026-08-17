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

### 3.1 Biên còn lại của trần/generation — tính ngày 15/08/2026

Trần `maxCostPerGenerationUsd = 0.05`. Với thang tier hiện hành và
`facebook_content.maxOutputTokens = 3000`, chạy `projectAttemptCostUsd` trên
prompt thật (~2.2k ký tự, 1 ảnh bìa):

| Bậc | Model | Ước trước khi gọi |
|---|---|---:|
| cheap | gpt-4.1-mini | $0.0055 |
| mid | gpt-5.4-mini | $0.0148 |
| top | gpt-4.1 | $0.0275 |
| | **Tổng xấu nhất** | **$0.0478** |

**Chỉ còn ~$0.002 (~4%) biên** — theo ƯỚC LƯỢNG. Đây là tổng 3 lần ước trước khi
gọi (mỗi lần tính đủ `maxOutputTokens = 3000`), không phải chi tiêu thật: thực tế
một caption chỉ tốn ~300–500 token output nên tiền tiêu ra thấp hơn nhiều. Nhưng
trần được kiểm bằng **chi phí đã tiêu + ước lượng lượt kế tiếp**
(`content-engine.ts`), nên con số ước vẫn là thứ quyết định có chặn hay không. Prompt của lượt escalate cuối còn phình thêm vì
`{{otherCaptions}}` và `{{previousFailures}}`, nên bài nhiều kênh + mô tả dài có
thể bị `AI_BUDGET_EXCEEDED` chặn ở bậc top thay vì chạy — chặn đúng thiết kế,
nhưng là mất một lượt cứu bài.

Tính lại bảng này **trước khi** nâng `maxOutputTokens` hoặc đổi sang model đắt
hơn. Nếu muốn giữ đủ 3 bậc với model đắt hơn thì phải nâng trần một cách có chủ ý,
không phải nâng lặng lẽ.

## 4. Đòn bẩy chi phí theo thứ tự hiệu quả

1. **Routing đúng tier** (đã là kiến trúc) — chênh cheap↔top là ~7–30× mỗi token.
2. **1 ảnh vision/generation** (nguyên tắc #6) — ảnh là phần token đắt nhất của request; resize ảnh bìa xuống chuẩn vision (~1024px cạnh dài) trước khi gửi.
3. **Prompt caching** — system prompt + brand guideline ổn định, chỉ phần product data đổi.
4. **Không gọi AI cho việc thuật toán làm được** — so trùng caption giữa kênh dùng thuật toán chuỗi trước (D1), chỉ cân nhắc LLM khi có bằng chứng cần.
5. Tồn kho chặn TRƯỚC khi gọi AI (đã là rule bất biến) — với 75% mã hết hàng trong Sheet hiện tại, riêng rule này tiết kiệm phần lớn lượt gọi vô ích.

## 5. Trách nhiệm

Số liệu: bảng `ai_generation` (prompt-versioning.md mục 2) — không hệ thống billing riêng ở MVP. Review chi phí: mục cố định trong weekly review của PM, cạnh trạng thái audit TikTok.
