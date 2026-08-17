# ADR-001 — AI Provider Abstraction (AI Gateway + Model Registry)

**Trạng thái:** ✅ ACCEPTED — owner duyệt 12/08/2026 · **Ngày:** 12/08/2026 · **Người đề xuất:** PM + AI agent
**Thay thế:** quyết định ngầm trong doc 02 ("AI: Anthropic API claude-opus-5" gọi qua một port đơn)

## Bối cảnh

Hệ thống sinh content bán hàng high-volume, mỗi bài × mỗi kênh là một lượt gọi AI, định hướng SaaS đa tenant. Kiến trúc hiện tại (doc 07) đã có port `CaptionGenerator` — business không gọi SDK trực tiếp — nhưng: 1 provider duy nhất, model ghi cứng trong tài liệu/agent, không routing theo chi phí, không evaluation, không generation log chuẩn.

## Quyết định

Dựng **AI Service** (vertical `core/ai`) + **AI Gateway** + **Model Registry** như mô tả ở `architecture.md`, `provider-strategy.md`, `model-routing.md`. Business chỉ biết port `ContentEngine`; SDK chỉ tồn tại trong `adapters/ai/**`; model chỉ tồn tại trong registry.

## Trả lời 10 câu hỏi bắt buộc

**1. Vì sao không couple provider (OpenAI/Anthropic) trực tiếp?**
Provider là phần biến động nhất của stack: giá đổi theo quý (GPT-5.4 mini vừa giảm ~50%, Sonnet 5 đang giá intro có hạn), model bị deprecate theo chu kỳ ngắn, và chất lượng tương đối giữa các provider đảo chiều liên tục. Couple SDK vào business logic biến mỗi biến động thị trường thành một đợt sửa business code + regression test toàn bộ. Với luật một chiều của doc 07, đây còn là hệ quả bắt buộc: SDK là I/O, I/O chỉ được sống trong adapters.

**2. Vì sao cần AI Gateway (chứ không chỉ nhiều adapter)?**
Có adapter riêng lẻ mới giải quyết "gọi ai"; gateway giải quyết phần lặp lại ở MỌI lời gọi: chọn model theo policy, timeout, fallback provider, escalation, đo token/chi phí/latency, ghi generation log. Không có gateway thì từng usecase tự làm — trùng lặp, lệch nhau, và observability thủng lỗ chỗ.

**3. Vì sao cần model routing?**
High-volume: chênh giá cheap-tier ↔ flagship là ~7–30×/token. Mặc định flagship cho 100% request nghĩa là trả giá flagship cho ~90% việc mà model rẻ làm đạt (giả thuyết — benchmark kiểm chứng). Routing theo task + escalation theo validation cho chất lượng-khi-cần với chi-phí-khi-thường.

**4. Vì sao cần validation?**
Output đăng CÔNG KHAI dưới tên thương hiệu. Brief đã đặt các rule cứng (không giá, tên nhất quán, 3–5 hashtag); validation còn là **tín hiệu điều khiển** của routing (fail → escalate) và là **số đo chất lượng model** (pass-rate lần đầu). Không validation thì routing mù và benchmark không có thước.

**5. Vì sao cần evaluation dataset?**
"Model nào tốt cho tiếng Việt bán hàng thời trang trên dữ liệu của CHÚNG TA" không có trong bất kỳ leaderboard công khai nào. Không có eval nội bộ thì mọi quyết định model là cảm tính, và không có cách nào phát hiện model mới rẻ hơn mà đủ tốt. Dataset xây từ dữ liệu thật đã khảo sát (`sample-data/`), chi phí một lần chạy <$20.

**6. Khi nào dùng cheap model?**
Mặc định — mọi task bắt đầu ở tier `cheap` trừ khi registry ghi khác. `difficult_content` (ảnh mờ/mô tả nghèo/người vận hành gắn cờ) bắt đầu ở `mid`. Không có đường "chọn tay model" trong luồng nghiệp vụ thường.

**7. Khi nào escalate?**
Chỉ khi generation THÀNH CÔNG về mặt hạ tầng nhưng **fail validation** (business/claim/policy) — nâng đúng một bậc tier theo `escalate:` của task, prompt kèm lý do fail, tối đa `maxEscalations` (2 với facebook_content). Hết bậc vẫn fail → cần người xử lý, không đăng. Escalation KHÔNG dùng cho lỗi timeout/rate-limit.

**8. Khi nào fallback provider?**
Chỉ khi lỗi HẠ TẦNG: `AI_TIMEOUT`, `AI_RATE_LIMITED`, `AI_PROVIDER_DOWN` — đổi provider, GIỮ hạng model (phần tử kế tiếp cùng tier trong registry), tối đa 1 lần rồi graceful failure. `AI_BAD_REQUEST` không fallback (lỗi của mình); `AI_CONTENT_REFUSED` thử 1 provider khác cùng tier rồi dừng. Hai đường fallback/escalation log cờ riêng để tách "provider chập chờn" khỏi "model yếu".

**9. Cách kiểm soát cost?**
Bốn tầng (chi tiết `cost-model.md`): trần/generation (escalation không vượt) → hạn mức/ngày/tenant → cảnh báo bất thường (2× trung bình 7 ngày) → đòn bẩy cấu trúc (routing, 1 ảnh vision, prompt caching, tồn kho chặn trước AI). KPI: cost/bài published, xem hằng tuần từ bảng `ai_generation`.

**10. Cách thay provider/model mà không ảnh hưởng business domain?**
Ba mức, đều không đụng business code: (a) đổi model trong tier — sửa 1 dòng YAML registry (kèm số benchmark trong PR); (b) đổi ưu tiên provider — đổi thứ tự trong tier; (c) thêm provider mới — viết 1 adapter implement `AIProviderAdapter` + thêm vào registry. Business usecase chỉ biết `task`, không biết model; hợp đồng `ContentEngine` + `GeneratedContent` schema là điểm bất biến.

## Hệ quả

**Tích cực:** thay model = sửa config; chi phí kiểm soát được và nhìn thấy được; chất lượng đo được theo model/prompt version; đường mở SaaS không đổi kiến trúc.
**Tiêu cực (chấp nhận):** +3.5 MD E4 (gateway, registry, log) + 2 MD E4.9 (evaluation); thêm một tầng indirection phải học; benchmark cần shop tham gia chấm rubric.
**Rủi ro tồn dư:** claim validator rule thuần không bắt 100% hallucination → giữ người-duyệt-mặc-định-BẬT (brief 7.6) và đo hallucination rate qua eval.

## Quyết định đã chốt trong quá trình duyệt

- **15/08/2026 (owner): tạm rút xuống MỘT provider — OpenAI.** Chưa cấp được key Google AI Studio paid tier, mà ràng buộc paid-tier bên dưới là không thương lượng, nên hệ thống không khởi chạy được. Quyết định 12/08 vẫn là đích đến; phần bị hoãn chỉ là *tiers nào trỏ vào provider nào*. Hệ quả cần biết: **không còn đường provider fallback** (fallback theo thiết kế phải đổi sang provider KHÁC). Chi tiết + cách bật lại: `provider-strategy.md` §3.1.
- **12/08/2026 (owner): Google AI Studio (Gemini API) làm provider chính** vì chi phí. Hệ quả kiến trúc:
  - Adapter ngày 1: **Google (primary, phủ 3 tier) + OpenAI (fallback hạ tầng)**. Anthropic → đợt 2 nếu benchmark cần.
  - **Ràng buộc kèm theo (không thương lượng): PAID TIER từ môi trường có dữ liệu thật.** Free tier của AI Studio cho Google quyền dùng dữ liệu gửi lên để training — dữ liệu sản phẩm/ảnh của shop không được đi qua đó. Paid tier không dùng data để training, giá token không đổi.
  - Benchmark đợt 1 (evaluation.md): Gemini 3.5 Flash-Lite vs 3.6 Flash vs GPT-5 mini — quyết định model trong tier vẫn theo số liệu, đúng nguyên tắc #13 ("không mặc định chọn vì rẻ" áp cho cả Gemini).

- **12/08/2026 (owner): Registry = YAML-trong-repo + DB override theo tenant** (như đề xuất). Bổ sung theo quyết định stack cùng ngày (Redis thay pg-boss): bản registry đã merge được **cache nóng trong Redis** với TTL ngắn — worker không đọc DB mỗi generation; invalidate khi override đổi.

## Duyệt

**Owner approve tổng thể 12/08/2026.** Doc 02/03/07, CLAUDE.md và agent `caption-ai` đã cập nhật theo `architecture.md` mục 6. Được phép implement từ session kế tiếp.
