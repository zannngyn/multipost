# Provider Strategy — Proposal (chờ duyệt)

## 1. Hợp đồng adapter — mọi provider nói cùng một ngôn ngữ

Business không bao giờ thấy `openai.responses.create(...)` hay `anthropic.messages.create(...)`. Mỗi provider là một adapter implement đúng một interface:

```ts
// core/ports/ai.ts
interface AIProviderAdapter {
  readonly provider: 'openai' | 'anthropic' | 'google';
  complete(req: NormalizedAIRequest): Promise<NormalizedAIResponse>;
  capabilities(model: string): ModelCapabilities; // vision, structuredOutput, maxContext
}

type NormalizedAIRequest = {
  model: string;                    // id do ModelPolicy quyết, adapter không tự chọn
  system: string;
  messages: NormalizedMessage[];    // text + image (đã resize/nén ở tầng media)
  outputSchema: JSONSchema;         // structured output — BẮT BUỘC với generation task
  maxOutputTokens: number;
  timeoutMs: number;
  metadata: { generationId: string; task: string; tenantId: string };
};

type NormalizedAIResponse = {
  output: unknown;                  // parse theo schema ở validation stage 1, adapter không parse nghiệp vụ
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  latencyMs: number;
  raw?: { finishReason: string };   // để debug, không cho business đọc
};
```

Quy tắc adapter:
- Wrap mọi lỗi SDK thành `AppError` có phân loại: `AI_TIMEOUT`, `AI_RATE_LIMITED`, `AI_PROVIDER_DOWN`, `AI_CONTENT_REFUSED`, `AI_BAD_REQUEST` — gateway quyết định fallback dựa trên code này, không dựa trên message.
- Adapter KHÔNG retry (gateway sở hữu retry/fallback — tránh retry chồng retry).
- Adapter KHÔNG biết task/policy — chỉ thi hành request đã chuẩn hoá.

## 2. Bảng model hiện hành (nguyên tắc #13)

Số liệu thu thập 12/08/2026. ⚠️ Giá OpenAI/Google lấy từ aggregator bên thứ ba, **phải verify lại trên trang giá chính thức trước khi chốt**; giá Anthropic là giá niêm yết chính thức. Cột "Chất lượng tiếng Việt" và "Reliability" để trống có chủ đích — **chỉ được điền bằng benchmark trên eval dataset** (nguyên tắc #10), không điền bằng cảm tính.

| Provider | Model | Vision | Structured output | Input $/M | Output $/M | Context | TV quality | Ghi chú |
|---|---|---|---|---:|---:|---|---|---|
| OpenAI | GPT-5.4 mini | ✅ | ✅ | $0.75 (nguồn khác: $0.375 sau đợt giảm — cần verify) | $4.50 / $2.25 | — | *chờ benchmark* | Fallback tier mid; cached input $0.075/M |
| OpenAI | GPT-5 mini | ✅ | ✅ | $0.25 | $2.00 | — | *chờ benchmark* | Rẻ nhất OpenAI — đưa vào benchmark, không mặc định chọn vì rẻ |
| OpenAI | GPT-5 (flagship) | ✅ | ✅ | cao hơn đáng kể | | — | *chờ benchmark* | Bậc escalation |
| Anthropic | Haiku 4.5 | ✅ | ✅ | $1.00 | $5.00 | 200K | *chờ benchmark* | Ứng viên cheap-tier |
| Anthropic | Sonnet 5 | ✅ | ✅ | $3.00 (intro $2.00 đến 31/08/2026) | $15.00 (intro $10.00) | 1M | *chờ benchmark* | Bậc giữa |
| Anthropic | Opus 5 | ✅ | ✅ | $5.00 | $25.00 | 1M | *chờ benchmark* | Bậc escalation cao nhất — KHÔNG dùng mặc định cho high-volume |
| Google | Gemini 3.5 Flash-Lite | ✅ | ✅ | $0.30 | $2.50 | — | *chờ benchmark* | **PRIMARY cheap tier** (quyết định 12/08) |
| Google | Gemini 3.6 Flash | ✅ | ✅ | $1.50 | $7.50 | — | *chờ benchmark* | **PRIMARY mid tier** |
| Google | Gemini 3.1 Pro | ✅ | ✅ | $2.00 (>200K: $4) | $12.00 (>200K: $18) | dài | *chờ benchmark* | **PRIMARY top tier** |

Nguồn: [CloudZero OpenAI pricing](https://www.cloudzero.com/blog/openai-pricing/), [Morph OpenAI pricing table](https://www.morphllm.com/openai-api-pricing), [pricepertoken GPT-5.4 mini](https://pricepertoken.com/pricing-page/model/openai-gpt-5.4-mini), [CloudZero Gemini pricing](https://www.cloudzero.com/blog/gemini-pricing/), [pricepertoken Gemini](https://pricepertoken.com/pricing-page/model/google-gemini-3.5-flash), giá Anthropic theo bảng giá chính thức hiện hành.

## 3. Provider theo đợt

### 3.1 Hiện hành — quyết định owner 15/08/2026: MỘT PROVIDER, OpenAI

Chưa cấp được key Google AI Studio paid tier, mà mục 3.2 cấm dùng free tier với
dữ liệu thật. Thay vì để hệ thống không chạy được, **tạm rút xuống một provider
duy nhất là OpenAI**.

| Tier | Model | Ghi chú |
|---|---|---|
| cheap | `openai:gpt-5-mini` | Primary mọi generation |
| mid | `openai:gpt-5.4-mini` | Bậc escalation 1 |
| top | `openai:gpt-5.4-mini` | PENDING(price-verify) — `openai:gpt-5` mới là model đích, nhưng giá còn là placeholder cao nên trần $0.05/generation sẽ chặn mọi lần escalate lên top. Tạm dùng lại model mid: vẫn được thêm một lượt sinh có feedback validator, chỉ là không lên model to hơn |

**Hệ quả phải chấp nhận:** đường **provider fallback ở mục 4 tạm thời không tồn
tại**. `selectFallbackModel` chỉ đổi sang provider KHÁC; còn một provider thì
`AI_TIMEOUT` / `AI_RATE_LIMITED` / `AI_PROVIDER_DOWN` làm generation fail luôn,
không có retry. Đây là đánh đổi có chủ ý, không phải bug.

**Bật lại Google** (không cần sửa code):
1. Cấp `GOOGLE_AI_API_KEY` paid tier (điều kiện mục 3.2 vẫn nguyên giá trị).
2. Thêm lại các key `google:*` vào vị trí 1 của từng tier trong `config/ai-models.yaml`
   (comment hướng dẫn nằm ngay trong file).
3. Khôi phục các bước Gemini + fallback trong `scripts/ai-live-smoke.ts` từ lịch sử git.

### 3.2 Định hướng gốc — quyết định owner 12/08/2026 (đang tạm hoãn)

**Quyết định: Google AI Studio (Gemini API) làm provider chính** — ưu tiên chi phí.

| Đợt | Adapter | Vai trò |
|---|---|---|
| MVP (Phase 1) | **Google (primary)** — Gemini 3.5 Flash-Lite (cheap) / 3.6 Flash (mid) / 3.1 Pro (top): đủ cả 3 tier trong MỘT provider | Primary mọi tier |
| MVP (Phase 1) | **OpenAI (fallback hạ tầng)** — GPT-5 mini ($0.25/$2, rẻ nhất làm fallback cheap-tier) | Chỉ chạy khi Google timeout/down/rate-limit |
| Đợt 2 | + Anthropic | Khi có số benchmark cho thấy cần, thêm ~1 MD vì hợp đồng adapter đã chuẩn |

### ⚠️ Điều kiện BẮT BUỘC khi dùng Google AI Studio

1. **Phải dùng PAID TIER (bật billing) ngay từ môi trường có dữ liệu thật.** Free tier của AI Studio cho phép Google **dùng dữ liệu gửi lên để training model** — mô tả sản phẩm và ảnh của shop là tài sản kinh doanh, không được đi qua free tier. Paid tier (và Vertex AI) không dùng dữ liệu để training. Giá token không đổi so với bảng ở mục 2; chi phí thật vẫn là vài chục USD/tháng ở khối lượng MVP.
2. Free tier CHỈ được dùng cho: thử nghiệm cục bộ với dữ liệu giả. Benchmark trên dữ liệu thật (evaluation.md) cũng chạy paid tier.
3. Rate limit theo tier trả phí: Tier 1 ~150–300 RPM — dư cho 60 generation/ngày của MVP; theo dõi khi mở SaaS.
4. AI Studio (Generative Language API) chọn thay vì Vertex AI cho MVP vì setup nhẹ (API key, không cần GCP project IAM phức tạp); đường lên Vertex để sau nếu cần SLA/region — cùng model, đổi adapter config, không đổi kiến trúc.

## 4. Fallback ≠ Escalation — hai đường khác nhau (nguyên tắc #11)

| | Trigger | Hành động | Model đích |
|---|---|---|---|
| **Provider fallback** ⚠️ *bất hoạt từ 15/08/2026 — xem mục 3.1* | `AI_TIMEOUT`, `AI_RATE_LIMITED`, `AI_PROVIDER_DOWN` (lỗi HẠ TẦNG) | Đổi PROVIDER, giữ nguyên hạng model, giữ nguyên prompt | Cùng tier ở provider khác (theo registry `fallback:`) |
| **Quality escalation** | Validation FAIL sau khi sinh thành công (lỗi CHẤT LƯỢNG) | Giữ hoặc đổi provider, NÂNG hạng model, kèm feedback lỗi validation vào prompt | Tier cao hơn (theo registry `escalate:`) |
| Không bao giờ | `AI_BAD_REQUEST` (lỗi của mình) | Không fallback, không escalate — fail nhanh, log, sửa code | — |
| `AI_CONTENT_REFUSED` | Provider từ chối nội dung | Thử 1 provider khác cùng tier; vẫn từ chối → cần người xử lý | Cùng tier |

Fallback mù quáng bị cấm: gateway phân nhánh theo error code, mỗi nhánh log `fallbackUsed`/`escalationUsed` riêng để dashboard tách được "provider chập chờn" khỏi "model yếu".

## 5. Chuỗi giới hạn

- Tối đa **1 fallback provider + 2 bậc escalation** cho một generation; vượt → trạng thái cần người xử lý.
- Ngân sách trần mỗi generation (xem `cost-model.md`) — escalation không được vượt trần; chạm trần → dừng, báo.
