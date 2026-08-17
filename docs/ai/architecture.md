# AI Architecture — ✅ APPROVED 12/08/2026

**Trạng thái: ĐÃ DUYỆT — được phép implement.** Tài liệu này là kết quả review kiến trúc hiện tại (doc 02/07) theo 14 nguyên tắc của chỉ đạo AI Architecture Review, 12/08/2026.

## 1. Đánh giá hiện trạng — chỗ nào đã lệch nguyên tắc

| Nguyên tắc | Hiện trạng (doc 02/07 + agent caption-ai) | Kết luận |
|---|---|---|
| #1 Không couple provider | Doc 07 đã có port `CaptionGenerator` — business KHÔNG gọi SDK trực tiếp ✅. Nhưng chỉ có 1 adapter Anthropic, không có tầng gateway/policy ⚠️ | Nâng cấp: port giữ nguyên, thêm AI Gateway phía sau |
| #2 Không hardcode model | `claude-opus-5` ghi cứng trong doc 02, agent caption-ai ❌ | Chuyển sang Model Registry theo task |
| #3 Cost/quality routing | Chưa có — mặc định flagship ❌ | Thêm policy cheap→validate→escalate |
| #4 Structured output | Validator đã có nhưng nhận text tự do rồi kiểm regex ⚠️ | Chuyển sang schema-first (structured outputs của provider) |
| #5 Không bịa facts | Whitelist trường vào prompt đã có ✅; Claim Validator so ngược output với dữ liệu gốc chưa đủ hệ thống ⚠️ | Thêm Claim Validator stage riêng |
| #6 1 ảnh cho vision MVP | Chưa quy định — đang "gửi kèm ảnh" chung chung ❌ | Chốt: chỉ ảnh bìa; VisionInput mở rộng được |
| #7 Platform-aware | Đã có prompt template theo nền tảng ✅; chưa có `ContentGenerationRequest` đủ trường ⚠️ | Chuẩn hoá request object |
| #8 Prompt versioned | Đã có "template có phiên bản, lưu DB" ✅; thiếu generation log đầy đủ ⚠️ | Bổ sung bảng `ai_generation` |
| #9 Observability | Có theo dõi chi phí/hạn mức ✅; thiếu per-request metrics chuẩn ⚠️ | Chuẩn hoá field log |
| #10 Evaluation dataset | Chưa có ❌ — nhưng đã có nguyên liệu: `sample-data/` 5.497 file + Sheet thật | Xây từ dữ liệu thật |
| #11 Provider fallback | Chưa có ❌ | Gateway xử lý, tách timeout-fallback vs quality-escalation |
| #12 Không God Service | Ranh giới domain đã chặt (doc 07) ✅ | Giữ; AI Service = vertical riêng trong core |
| #13 Model data hiện hành | Doc 02 chọn Opus 5 theo mặc định, chưa benchmark ❌ | Bảng model hiện hành ở `provider-strategy.md`; quyết định cuối chờ benchmark |
| #14 ADR + docs | Chưa có | Bộ tài liệu này |

## 2. Kiến trúc đề xuất — đặt vào khung Clean Architecture (doc 07)

Không phá luật một chiều hiện có. AI trở thành một **vertical trong core** với ports riêng; mọi SDK nằm ở adapters.

```
Business usecases (compose-post, generate-captions cho post)
      │  chỉ biết port này
      ▼
core/ports/content-engine.ts        ContentEngine.generate(ContentGenerationRequest)
      │
      ▼
core/ai/  ────────────────────────  "AI Service" (usecase + domain thuần)
 ├── content-engine.ts              orchestrate: build context → route → generate → validate → escalate
 ├── model-policy.ts                đọc registry, chọn provider+model theo task (domain logic thuần)
 ├── gateway.ts                     gọi provider qua port, timeout/fallback/retry, ghi observability
 └── validation/                    pipeline 4 tầng (schema → business → claim → content policy)
      │  chỉ biết các port dưới
      ▼
core/ports/ai.ts
 ├── AIProviderAdapter              complete(NormalizedRequest) → NormalizedResponse
 ├── ModelPolicyStore               đọc/ghi registry (config + DB override)
 ├── PromptStore                    template có phiên bản
 └── GenerationLog                  ghi ai_generation
      │
      ▼
adapters/ai/
 ├── openai/                        implement AIProviderAdapter
 ├── anthropic/                     implement AIProviderAdapter
 ├── google/                        implement AIProviderAdapter (đợt 2)
 └── registry-store/                YAML trong repo + bảng DB override theo tenant
```

- **Port `CaptionGenerator` cũ đổi tên thành `ContentEngine`** với request platform-aware (nguyên tắc #7). Business usecase không đổi gì khác — đúng mục tiêu "thay model không sửa business logic".
- `core/ai` KHÔNG chứa: logic sản phẩm, logic Facebook, logic campaign, pricing (nguyên tắc #12). Nó chỉ Understand / Generate / Transform / Classify / Validate-AI-output. Product facts đến từ `compose-post` (Product domain) dưới dạng **AIContext bất biến** — AI Service không tra Sheet, không tra DB sản phẩm.

## 3. ContentGenerationRequest (nguyên tắc #7)

```ts
type ContentGenerationRequest = {
  task: AITask;                    // 'facebook_content' | 'product_understanding' | ...
  product: CanonicalProductData;   // từ Product domain — nguồn sự thật duy nhất
  platform: 'facebook' | 'tiktok' | 'instagram' | 'shopee' | 'lazada' | 'taobao';
  contentType: 'photo_post' | 'video_post' | 'reel';
  vision: VisionInput;             // xem mục 4
  brandVoice?: string;             // từ prompt template + tenant config
  language: 'vi';
  campaign?: CampaignRef;          // Phase sau — có chỗ sẵn, chưa dùng
  constraints: ContentConstraints; // hashtag 3–5, không giá, tên bắt buộc...
};
```

MVP chỉ implement `platform: 'facebook'`; union type + prompt template theo platform bảo đảm thêm nền tảng không đổi domain.

## 4. VisionInput — 1 ảnh ở MVP (nguyên tắc #6)

```ts
type VisionInput =
  | { mode: 'single'; image: MediaRef }      // MVP: LUÔN là ảnh bìa (ảnh đầu tiên đã chọn)
  | { mode: 'multi';  images: MediaRef[] };  // future — chỉ khi task khai báo cần multi-image
```

Rule MVP: chỉ `image[0]` (ảnh bìa) đi vào vision model. Ưu tiên ảnh có hậu tố `-THỰC TẾ` nếu có (dữ liệu thật đáng tin hơn ảnh AI — xem doc 05). Registry mỗi task khai báo `vision: none | single | multi` — task nào không cần nhìn ảnh thì không gửi ảnh (tiết kiệm thêm).

## 5. Luồng chuẩn một lần sinh content

```
compose-post (đã qua tồn kho — thứ tự bất biến CLAUDE.md giữ nguyên)
   ↓ AIContext = CanonicalProductData(whitelist) + ảnh bìa + constraints
ContentEngine.generate(request)
   ↓ ModelPolicy: task → primary model (rẻ, đủ năng lực)
Gateway → ProviderAdapter (structured output, schema GeneratedContent)
   ↓
Validation pipeline: schema → business → claim → content-policy
   ├─ PASS → trả GeneratedContent + generationId (đã log đủ metrics)
   └─ FAIL (quality) → escalate model mạnh hơn theo policy → validate lại (tối đa N bậc)
        └─ vẫn FAIL → trạng thái cần người xử lý (không đăng, không nuốt)
   ⚡ Provider timeout/5xx/rate-limit → fallback PROVIDER khác, CÙNG hạng model (không phải escalation)
```

Chi tiết routing: `model-routing.md`. Chi tiết validation: `validation.md`. Phân biệt fallback vs escalation: `provider-strategy.md` mục 4.

## 6. Ảnh hưởng tới tài liệu & estimate hiện có (áp dụng SAU khi duyệt)

| Mục | Thay đổi |
|---|---|
| doc 02 stack | Dòng "AI: Anthropic claude-opus-5" → "AI: qua AI Gateway đa provider, model theo registry" |
| doc 07 | `ports/caption-gen.ts` → `ports/content-engine.ts` + thêm `core/ai` vertical, `adapters/ai/*` |
| Agent `caption-ai` | Đổi mission: sở hữu `core/ai` + `adapters/ai`; cấm gọi SDK ngoài adapter; model lấy từ registry |
| WBS E4 | +3.5 MD (gateway + registry + generation log + structured output). Eval dataset: hạng mục mới **E4.9 (+2 MD)** |
| CLAUDE.md | Thêm rule: "cấm import SDK AI ngoài `adapters/ai/**`; cấm string model trong business code" |

## 7. Điểm chờ quyết định khi duyệt

1. ⚠️ **TẠM HOÃN 15/08/2026 — hiện chạy MỘT provider: OpenAI** (chưa cấp được key Google paid tier). Chi tiết + cách bật lại: `provider-strategy.md` §3.1. Quyết định gốc bên dưới vẫn là đích đến.
   ✅ **ĐÃ CHỐT (owner, 12/08/2026): Google AI Studio làm provider chính** — Gemini phủ cả 3 tier; OpenAI làm fallback hạ tầng ngày 1; Anthropic đợt 2 nếu benchmark cần. **Điều kiện bắt buộc: paid tier từ môi trường có dữ liệu thật** (free tier cho Google quyền dùng dữ liệu để training — xem provider-strategy.md mục 3).
2. ⏳ **Model cụ thể trong từng tier**: đề xuất Gemini 3.5 Flash-Lite (cheap) / 3.6 Flash (mid) / 3.1 Pro (top), nhưng **chốt sau benchmark** trên eval dataset (nguyên tắc #10, #13) — benchmark đợt 1 so Flash-Lite vs Flash vs GPT-5 mini trên tiếng Việt bán hàng.
3. ✅ **ĐÃ CHỐT (owner, 12/08/2026): Registry = YAML-trong-repo + DB override theo tenant**, cache nóng trong Redis (stack đã có Redis từ quyết định cùng ngày).
